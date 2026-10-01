// Runner agent: keeps one machine's projects in line with the control plane.
// It joins the fleet (the control plane gives it a slot n and the token for tunnel runner-n), starts a local router
// and the tunnel, checks in every few seconds, starts, updates and removes docker compose projects to match what it's
// told, and restarts ones that stop answering. A stateful project's replica gets its own directory in the fleet's
// R2 bucket, mounted here with rclone and bound into its containers. On GitHub Actions it also starts machines the
// control plane says are missing and hands over to a fresh run before GitHub's 6-hour limit; on any other host it
// just keeps running.
// No dependencies: Node's built-ins plus the docker CLI.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { startMetrics } from "./metrics.mjs";

const env = process.env;
const github = env.GITHUB_ACTIONS === "true";
const base = github ? env.RUNNER_TEMP : (env.RUNNER_DATA ?? "/var/lib/runner");
const started = Date.now();
const hardStop = github ? started + 355 * 60_000 : Infinity; // leave before GitHub kills the job at 6 hours
const selfHandover = github ? started + 330 * 60_000 : Infinity; // start a replacement ourselves if not asked by then
const settleBy = started + 10 * 60_000; // open the tunnel by then even if a project is still struggling
// With no word from the control plane for this long, stateful projects are stopped: after 75 s it counts this run
// as gone and mounts their data elsewhere, and data must never be written from two machines.
const FENCE_MS = 70_000;
const ROUTER_PORT = 19080; // the tunnel sends everything here, and the router (Caddy) picks the project by hostname
const dir = `${base}/projects`;
const routerDir = `${base}/router`;
let machine = 0; // the slot, from the control plane
let tunnelToken = "";
let storage = null; // { endpoint, bucket, accessKeyId, secretAccessKey } for the fleet's R2 bucket, from the control plane
const RCLONE = "rclone/rclone:1.75"; // mounts a replica's R2 directory (one container per stateful project)
let agent = ""; // GitHub: one per run; a host keeps its ID in its data folder, so it gets its slot back after a restart
let run = "";
// Commands run without the agent's own secrets, so a compose file can't read them.
const cleanEnv = Object.fromEntries(
  Object.entries(env).filter(([k]) => !["TUNNEL_TOKEN", "CONTROL_TOKEN", "GH_TOKEN"].includes(k)),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

function sh(cmd, args, { timeout = 15 * 60_000, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 << 20, env: { ...cleanEnv, ...extraEnv } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

// GET / for a hostname through the local router: { code, routed }, with code 0 if nothing answered.
// The router's own "no such project" 404 carries X-Runner-Route: none, so it isn't mistaken for the project's.
function probe(host) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: ROUTER_PORT, path: "/", headers: { host }, timeout: 5000 }, (res) => {
      res.resume();
      resolve({ code: res.statusCode, routed: res.headers["x-runner-route"] !== "none" });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ code: 0, routed: false }));
  });
}

// True once the project answers through the router, the way real traffic reaches it. Any status counts
// except the router's "no such project" and its 502 for "the project isn't answering".
async function answers(name, seconds) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const { code, routed } = await probe(`${name}-${machine}.${domain}`);
    if (code && routed && code !== 502) return true;
    if (Date.now() >= end) return false;
    await sleep(2000);
  }
}

// ---- projects ----

const projects = new Map(); // name -> { v, port, s: "applying" | "healthy" | "failed", e, busy, at, misses }
let domain = "";

async function apply(name, want) {
  const p = { v: want.v, port: want.port, s: "applying", e: "", busy: true, at: Date.now(), misses: 0, storage: want.storage ?? null };
  projects.set(name, p);
  updateRouter();
  log(`${name}: starting v${want.v}${want.storage ? ` with its data (${want.storage.prefix}${want.storage.readOnly ? ", read-only" : ""})` : ""}`);
  let s = "healthy";
  let e = "";
  try {
    const projectDir = `${dir}/${name}`;
    const file = `${projectDir}/compose.yaml`;
    await mkdir(projectDir, { recursive: true });
    if (want.storage) await ensureMount(name, want.storage); // before compose up: its containers bind the mount
    // Dockerfiles and anything else the build needs sit next to the compose file, so `build: .` finds them.
    // The folder isn't cleared first: relative bind mounts (./data) may live in it.
    for (const [path, content] of Object.entries(want.files ?? {})) {
      const target = resolve(projectDir, path);
      if (!target.startsWith(`${projectDir}/`)) throw new Error(`file path ${path} points outside the project`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(file, want.compose);
    // compose only recreates the containers whose config changed, and --wait fails if one won't stay up.
    // A stateful project's containers are always recreated, so they bind the mount that's there now.
    const up = await sh("docker", ["compose", "-p", name, "-f", file, "up", "-d", "--build", "--remove-orphans",
      "--wait", "--wait-timeout", "300", ...(want.storage ? ["--force-recreate"] : [])]);
    if (!up.ok) [s, e] = ["failed", up.out.split("\n").slice(-6).join("\n").slice(-600)];
    else if (want.port && !(await answers(name, 60))) [s, e] = ["failed", `nothing answers on port ${want.port} through the router`];
  } catch (err) {
    [s, e] = ["failed", err.message];
  }
  Object.assign(p, { s, e, busy: false, at: Date.now() });
  log(`${name}: v${want.v} ${s}${e ? ` (${e.split("\n").pop()})` : ""}`);
}

async function remove(name) {
  const p = projects.get(name);
  p.busy = true;
  log(`${name}: removing`);
  if (p.storage) await stopStateful(name); // stop, let the last writes reach R2, unmount
  await sh("docker", ["compose", "-p", name, "-f", `${dir}/${name}/compose.yaml`, "down", "--remove-orphans"]);
  projects.delete(name);
  await rm(`${dir}/${name}`, { recursive: true, force: true });
  updateRouter();
}

// Start what's new or changed, retry what failed, remove what's no longer wanted.
function reconcile(desired) {
  for (const [name, want] of Object.entries(desired)) {
    const p = projects.get(name);
    if (p?.busy) continue;
    const retry = (p?.s === "failed" && Date.now() - p.at > 3 * 60_000) || p?.s === "fenced";
    const storageChanged = Boolean(p?.storage) !== Boolean(want.storage) || (want.storage && p.storage.readOnly !== want.storage.readOnly);
    if (!p || p.v !== want.v || p.port !== want.port || storageChanged || retry) apply(name, want).catch((e) => log(`${name}: ${e.message}`));
  }
  for (const [name, p] of projects) {
    if (!(name in desired) && !p.busy) remove(name).catch((e) => log(`${name}: ${e.message}`));
  }
}

const settled = (desired) => Object.entries(desired).every(([name, want]) => {
  const p = projects.get(name);
  return p && p.v === want.v && !p.busy;
});

// A project that stops answering three checks in a row is marked failed, which makes reconcile start it again.
async function checkHealth() {
  for (const [name, p] of projects) {
    if (p.busy || p.s !== "healthy") continue;
    if (p.storage && !(await mounted(name))) {
      log(`${name}: its data mount died; remounting`);
      Object.assign(p, { s: "failed", e: "the data mount died; remounting", at: 0, misses: 0 });
      continue;
    }
    if (!p.port) continue;
    if (await answers(name, 0)) {
      p.misses = 0;
    } else if (++p.misses >= 3) {
      log(`${name}: stopped answering on port ${p.port}; restarting it`);
      Object.assign(p, { s: "failed", e: `stopped answering on port ${p.port}`, at: 0, misses: 0 });
    }
  }
}

// ---- stateful projects: a replica's data directory, mounted from the fleet's R2 bucket ----
// One rclone container per project ("mnt-<name>"), FUSE-mounting r2:<bucket>/<project>/<replica> at the host path
// the compose file binds. Reads and writes go through a local cache; a file is in R2 once the app closes it.

const mounts = new Map(); // name -> the storage config it was mounted with
const MOUNT_ROOT = "/var/lib/runner/mounts"; // <project>/<replica> under here, the same path the control plane put in the compose file

// The mount container binds the project's folder and mounts into <replica> inside it: a bind's root always looks
// like a mount point (rclone would refuse it), and a mount made under a shared bind shows up on the host.
const mountOf = (st) => ({ parent: dirname(st.mount), replica: basename(st.mount) });

async function mounted(name) {
  const st = projects.get(name)?.storage ?? mounts.get(name);
  if (!st) return false;
  return (await sh("docker", ["exec", "mnt-" + name, "grep", "-q", ` /mnt/${mountOf(st).replica} fuse`, "/proc/mounts"], { timeout: 10_000 })).ok;
}

// Root work on the host's mount folder, from a privileged container: a dead mount container leaves its FUSE mount
// behind on the host, and a file written while nothing was mounted lands in the plain folder; both stop the next
// mount. (They aren't the replica's data; that's in R2.)
async function cleanMountDir(st) {
  const { replica } = mountOf(st);
  const rel = `/m/${basename(dirname(st.mount))}/${replica}`;
  const r = await sh("docker", ["run", "--rm", "--privileged", "-v", `${MOUNT_ROOT}:/m:rshared`, "alpine:3.20", "sh", "-c",
    `umount -l ${rel} 2>/dev/null; umount -l ${rel} 2>/dev/null; mkdir -p ${rel} && n=$(ls -A ${rel} | wc -l) && rm -rf ${rel}/* ${rel}/.[!.]* 2>/dev/null; echo $n`], { timeout: 60_000 });
  if (!r.ok) throw new Error(`couldn't prepare the mount folder: ${r.out.split("\n").pop()}`);
  if (Number(r.out.trim()) > 0) log(`${rel}: removed ${r.out.trim()} stray entries written while nothing was mounted`);
}

async function ensureMount(name, st) {
  if (!storage) throw new Error("the fleet's storage isn't set up, so this project can't have data");
  const have = mounts.get(name);
  if (have && have.prefix === st.prefix && have.readOnly === st.readOnly && (await mounted(name))) return;
  await sh("docker", ["rm", "-f", "mnt-" + name]);
  mounts.delete(name);
  await cleanMountDir(st);
  const { parent, replica } = mountOf(st);
  const cache = `${base}/cache/${name}`;
  await mkdir(cache, { recursive: true }).catch(() => {});
  const args = ["run", "-d", "--name", "mnt-" + name, "--restart", "unless-stopped",
    "--cap-add", "SYS_ADMIN", "--device", "/dev/fuse", "--security-opt", "apparmor:unconfined",
    "-e", "RCLONE_CONFIG_R2_TYPE=s3", "-e", "RCLONE_CONFIG_R2_PROVIDER=Cloudflare", "-e", `RCLONE_CONFIG_R2_ENDPOINT=${storage.endpoint}`,
    "-e", "RCLONE_CONFIG_R2_ACCESS_KEY_ID", "-e", "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY",
    "-e", "RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true", "-e", "RCLONE_CONFIG_R2_DIRECTORY_MARKERS=true",
    "-v", `${parent}:/mnt:rshared`, "-v", `${cache}:/cache`,
    RCLONE, "mount", `r2:${storage.bucket}/${st.prefix}`, `/mnt/${replica}`, "--allow-non-empty",
    "--allow-other", "--umask", "000", "--vfs-cache-mode", "full", "--cache-dir", "/cache",
    "--vfs-cache-max-size", `${st.limitMb}M`, "--vfs-cache-max-age", "48h", "--vfs-write-back", "1s",
    "--dir-cache-time", "30s", "--poll-interval", "0", "--rc", "--rc-addr", "127.0.0.1:5572", "--rc-no-auth",
    "--log-level", "NOTICE", ...(st.readOnly ? ["--read-only"] : [])];
  const creds = { RCLONE_CONFIG_R2_ACCESS_KEY_ID: storage.accessKeyId, RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: storage.secretAccessKey };
  let r = await sh("docker", args, { extraEnv: creds });
  if (!r.ok && github && /shared mount/.test(r.out)) {
    // The mount has to be visible to other containers; that needs shared propagation from the root filesystem.
    await sh("sudo", ["mount", "--make-rshared", "/"]);
    r = await sh("docker", args, { extraEnv: creds });
  }
  if (!r.ok) throw new Error(`couldn't start the data mount: ${r.out.split("\n").pop()}`);
  mounts.set(name, { prefix: st.prefix, readOnly: st.readOnly, mount: st.mount });
  for (let i = 0; i < 30; i++) {
    if (await mounted(name)) break;
    if (i === 29) {
      mounts.delete(name);
      throw new Error(`the data mount didn't come up: ${(await sh("docker", ["logs", "--tail", "3", "mnt-" + name])).out.split("\n").pop()}`);
    }
    await sleep(1000);
  }
  // Seen from another container too (that's how the project's containers get it).
  const seen = await sh("docker", ["run", "--rm", "-v", `${parent}:/m:ro`, "alpine:3.20", "grep", "-q", ` /m/${replica} fuse`, "/proc/mounts"], { timeout: 60_000 });
  if (!seen.ok) {
    mounts.delete(name);
    throw new Error("the data mount isn't visible to other containers (mount propagation)");
  }
}

// Writes still on their way to R2, per rclone's own stats.
async function pendingUploads(name) {
  const r = await sh("docker", ["exec", "mnt-" + name, "rclone", "rc", "vfs/stats"], { timeout: 10_000 });
  if (!r.ok) return 0;
  try {
    const c = JSON.parse(r.out).diskCache ?? {};
    return (c.uploadsInProgress ?? 0) + (c.uploadsQueued ?? 0);
  } catch {
    return 0;
  }
}

// Stop a stateful project the safe way: its containers first (so files get closed), then wait for the last
// uploads, then unmount. After this its data can be mounted somewhere else.
async function stopStateful(name) {
  await sh("docker", ["compose", "-p", name, "-f", `${dir}/${name}/compose.yaml`, "stop", "-t", "20"]);
  for (let i = 0; i < 90 && (await pendingUploads(name)) > 0; i++) await sleep(1000);
  await sleep(1500); // the write-back delay
  await sh("docker", ["stop", "-t", "30", "mnt-" + name]);
  await sh("docker", ["rm", "-f", "mnt-" + name]);
  const st = projects.get(name)?.storage ?? mounts.get(name);
  if (st) await cleanMountDir(st).catch((e) => log(`${name}: ${e.message}`));
  mounts.delete(name);
}

// On the way out: hand every stateful project's data back, and tell the control plane they're stopped, so the
// run taking over can mount it straight away.
async function releaseStateful() {
  const stateful = [...projects].filter(([, p]) => p.storage);
  if (!stateful.length) return;
  log(`stopping ${stateful.map(([name]) => name).join(", ")} so their data can move on`);
  for (const [name, p] of stateful) {
    p.busy = true;
    await stopStateful(name);
    await sh("docker", ["compose", "-p", name, "-f", `${dir}/${name}/compose.yaml`, "down"]);
    projects.delete(name);
  }
  await sync().catch(() => {});
}

// Stop stateful projects while the control plane is out of reach (see FENCE_MS). They're started again when it's
// back, if they're still wanted here.
async function fenceStateful(silentFor) {
  for (const [name, p] of projects) {
    if (!p.storage || p.busy || p.s === "fenced") continue;
    log(`${name}: no word from the control plane for ${Math.round(silentFor / 1000)}s; stopping it so its data isn't mounted on two machines`);
    p.busy = true;
    await stopStateful(name);
    Object.assign(p, { s: "fenced", e: "stopped: the control plane was out of reach, so its data may have moved", busy: false, at: Date.now() });
  }
}

const storageState = () => {
  const stateful = [...projects.values()].filter((p) => p.storage);
  return !storage ? "none" : stateful.some((p) => p.s === "failed" && /mount/.test(p.e)) ? "down" : "ok";
};

// ---- router (Caddy) and tunnel (cloudflared) ----

let routerChain = Promise.resolve();
let routerConfig = "";
// Queued so configs are applied in order.
const updateRouter = () => (routerChain = routerChain.then(loadRouter, loadRouter));

function routerJson() {
  const routes = [...projects]
    .filter(([, p]) => p.port && domain)
    .map(([name, p]) => ({
      match: [{ host: [`${name}-${machine}.${domain}`] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${p.port}` }], flush_interval: -1 }],
    }));
  routes.push({
    handle: [{
      handler: "static_response",
      status_code: 404,
      headers: { "X-Runner-Route": ["none"] },
      body: `No such project on machine ${machine}\n`,
    }],
  });
  return JSON.stringify({
    apps: { http: { servers: { router: { listen: [`127.0.0.1:${ROUTER_PORT}`], automatic_https: { disable: true }, routes } } } },
  });
}

// Goes through `caddy reload` rather than the admin API directly: Caddy's own CLI passes its origin checks.
async function loadRouter() {
  const body = routerJson();
  if (body === routerConfig) return;
  await writeFile(`${routerDir}/caddy.json`, body);
  const r = await sh("docker", ["exec", "router", "caddy", "reload", "--config", "/etc/router/caddy.json"]);
  if (r.ok) routerConfig = body;
  else log(`router update failed: ${r.out.split("\n").slice(-3).join(" ")}`);
}

async function startRouter() {
  await mkdir(routerDir, { recursive: true });
  routerConfig = routerJson();
  await writeFile(`${routerDir}/caddy.json`, routerConfig);
  const r = await sh("docker", ["run", "-d", "--name", "router", "--network", "host", "--restart", "unless-stopped",
    "-v", `${routerDir}:/etc/router:ro`, "caddy:2", "caddy", "run", "--config", "/etc/router/caddy.json"]);
  if (!r.ok) throw new Error(`router didn't start: ${r.out}`);
  for (let i = 0; i < 30; i++) {
    if ((await probe("check")).code) return;
    await sleep(1000);
  }
  throw new Error(`router isn't answering: ${(await sh("docker", ["logs", "--tail", "20", "router"])).out}`);
}

async function startTunnel() {
  await writeFile(`${base}/tunnel.yml`, `ingress:\n  - service: http://127.0.0.1:${ROUTER_PORT}\n`);
  const r = await sh("docker", ["run", "-d", "--name", "tunnel", "--network", "host", "--restart", "unless-stopped",
    "-e", "TUNNEL_TOKEN", "-v", `${base}/tunnel.yml:/etc/cloudflared/config.yml:ro`,
    "cloudflare/cloudflared:latest", "tunnel", "--no-autoupdate", "--config", "/etc/cloudflared/config.yml", "run"],
  { extraEnv: { TUNNEL_TOKEN: tunnelToken } });
  if (!r.ok) throw new Error(`tunnel didn't start: ${r.out}`);
  for (let i = 0; i < 45; i++) {
    if ((await sh("docker", ["logs", "tunnel"])).out.includes("Registered tunnel connection")) return log("tunnel online");
    await sleep(2000);
  }
  throw new Error(`tunnel didn't connect: ${(await sh("docker", ["logs", "--tail", "20", "tunnel"])).out}`);
}

// ---- control plane and GitHub ----

let ready = false;
let lastSyncOk = Date.now();

const metrics = startMetrics();

// Get a slot and its tunnel token. Keeps trying: the control plane may be unreachable, or every slot taken.
async function join() {
  if (github) {
    agent = `gh-${env.GITHUB_RUN_ID}`;
    run = env.GITHUB_RUN_ID;
  } else {
    const idFile = `${base}/agent-id`;
    agent = (await readFile(idFile, "utf8").catch(() => "")).trim();
    if (!agent) {
      agent = `host-${randomUUID().slice(0, 8)}`;
      await writeFile(idFile, agent);
    }
    run = `${agent}-${started}`;
  }
  for (let wait = 5;; wait = Math.min(wait * 2, 60)) {
    try {
      const res = await fetch(`${env.CONTROL_URL}/api/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.CONTROL_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ agent, kind: github ? "github" : "host", label: github ? null : hostname(), want: env.MACHINE ? Number(env.MACHINE) : undefined }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      ({ machine, tunnelToken, domain } = data);
      storage = data.storage ?? null;
      return log(`joined as machine ${machine} (${agent})`);
    } catch (e) {
      log(`couldn't join (${e.message}); trying again in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

// After a restart on a host: projects from last time that are no longer wanted.
async function removeLeftovers(desired) {
  for (const name of await readdir(dir).catch(() => [])) {
    if (name in desired || projects.has(name)) continue;
    log(`${name}: left over from before; removing`);
    await sh("docker", ["compose", "-p", name, "-f", `${dir}/${name}/compose.yaml`, "down", "--remove-orphans"]);
    await sh("docker", ["rm", "-f", "mnt-" + name]);
    await rm(`${dir}/${name}`, { recursive: true, force: true });
  }
}

async function sync() {
  const status = Object.fromEntries([...projects].map(([name, p]) => [name, { v: p.v, s: p.s, e: p.e || undefined }]));
  const sent = metrics.payload();
  const res = await fetch(`${env.CONTROL_URL}/api/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ machine, run, agent, kind: github ? "github" : "host", label: github ? null : hostname(), started, ready, status, storage: storageState(), leaving, metrics: sent }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  metrics.confirm(sent);
  return res.json();
}

async function startMachine(m) {
  if (!github) return; // only GitHub machines can start other GitHub machines
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/machine.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "runner-agent",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || "main", inputs: { machine: String(m) } }),
  }).catch((e) => ({ ok: false, status: e.message }));
  log(res.ok ? `started machine ${m}` : `couldn't start machine ${m}: ${res.status}`);
}

let stopping = false;
let releasing = false; // handing stateful data back before leaving: the main loop stands down meanwhile
let leaving = false; // told the control plane this run is going away for good (its replicas can be placed elsewhere now)
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`${reason}; stopping the tunnel`);
  // On a host, Docker restarts this container (fetching the latest agent), and it rejoins with the same slot.
  await sh("docker", ["stop", "-t", "10", "tunnel"]);
  process.exit(code);
}
// Stopped from outside: hand stateful projects' data back first if there's time (a host gives the agent 3 minutes).
// On GitHub that means the machine is going away for good, so its replicas can be placed elsewhere straight away;
// a host is probably just restarting its agent and keeps them.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping || releasing) return;
    releasing = true;
    leaving = github;
    Promise.race([releaseStateful(), sleep(150_000)]).finally(() => shutdown("cancelled"));
  });
}

async function main() {
  await mkdir(dir, { recursive: true });
  await join();
  log(`machine ${machine}, run ${run}${github ? "" : ` on ${hostname()}`}`);
  // A host may still have these from before a restart.
  await sh("docker", ["rm", "-f", "router", "tunnel"]);
  await startRouter();
  let cleaned = github;
  let successorAt = 0;
  let lastReport = 0;
  while (Date.now() < hardStop) {
    if (releasing) { // a signal handler is handing data back; don't start anything meanwhile
      await sleep(1000);
      continue;
    }
    let plan = null;
    try {
      plan = await sync();
      lastSyncOk = Date.now();
    } catch (e) {
      log(`control plane unreachable (${e.message}); keeping what's running`);
      if (Date.now() - lastSyncOk > FENCE_MS) await fenceStateful(Date.now() - lastSyncOk);
    }
    if (plan?.retire) {
      releasing = true;
      await releaseStateful();
      return shutdown("a newer run of this machine is healthy, so this one is leaving");
    }
    if (plan) {
      if (plan.domain !== domain) {
        domain = plan.domain;
        updateRouter();
      }
      if (JSON.stringify(plan.storage ?? null) !== JSON.stringify(storage)) {
        storage = plan.storage ?? null;
        log(storage ? "fleet storage is available" : "fleet storage isn't set up");
      }
      reconcile(plan.desired);
      if (!cleaned) {
        cleaned = true;
        await removeLeftovers(plan.desired);
      }
      for (const m of plan.start ?? []) await startMachine(m);
      if (plan.handover && !github) {
        releasing = true;
        await releaseStateful();
        return shutdown("restarting to update the agent");
      }
      if (plan.handover && Date.now() - successorAt > 10 * 60_000) {
        successorAt = Date.now();
        log("handing over to a fresh run of this machine");
        await startMachine(machine);
      }
    }
    if (!successorAt && Date.now() > selfHandover) {
      successorAt = Date.now();
      log("close to the 6-hour limit; starting a replacement");
      await startMachine(machine);
    }
    // Open the tunnel only once the projects are up, so a fresh run doesn't take traffic it can't serve yet.
    if (!ready && plan && (settled(plan.desired) || Date.now() > settleBy)) {
      await startTunnel();
      ready = true;
      continue; // check in straight away as ready
    }
    await checkHealth();
    if (Date.now() - lastReport > 5 * 60_000) {
      lastReport = Date.now();
      const summary = [...projects].map(([name, p]) => `${name} v${p.v} ${p.s}`).join(", ") || "no projects";
      log(`${ready ? "online" : "starting"}: ${summary}`);
    }
    await sleep((plan?.poll ?? 20) * 1000);
  }
  await releaseStateful();
  await shutdown("reached the time limit");
}

main().catch((e) => shutdown(`agent failed: ${e.stack ?? e}`, 1));

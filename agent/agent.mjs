// Runner agent: keeps one machine's projects in line with the control plane.
// It joins the fleet (the control plane gives it a slot n and the token for tunnel runner-n), starts a local router
// (it serves each project at <project>-m<n>, which is how the control plane's Worker reaches this machine) and the
// tunnel, checks in every few seconds, starts, updates and removes docker compose projects to match what it's told,
// and restarts ones that stop answering. It doesn't know what kind of machine it's on: the settings below describe it.
// No dependencies: Node's built-ins plus the docker CLI.
//   CONTROL_URL, JOIN_TOKEN   the control plane and the fleet's join token (required)
//   RUNNER_DATA   where projects and the agent's ID live (default /var/lib/runner)
//   AGENT_ID      this agent's ID (default: one made up once and kept in RUNNER_DATA, so a restart gets its slot back)
//   POOL, POOL_SIZE   the pool this machine belongs to and how many machines it should have (none: a standalone host)
//   MACHINE       the slot to take, when the machine was started for one
//   LABEL, LINK   what the status page calls it (default: the hostname) and links to
//   START_CMD     a shell command that starts a new machine for slot $SLOT. With it, the agent starts the pool members
//                 the control plane says are missing, and its own replacement when it's handed over; without it, a
//                 handover restarts the agent (where it runs under a supervisor, it comes back with the latest code)
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { startMetrics } from "./metrics.mjs";

const env = process.env;
const pool = env.POOL || null;
const base = env.RUNNER_DATA || "/var/lib/runner";
const started = Date.now();
const settleBy = started + 10 * 60_000; // open the tunnel by then even if a project is still struggling
const ROUTER_PORT = 19080; // the tunnel sends everything here, and the router (Caddy) picks the project by hostname
const dir = `${base}/projects`;
const routerDir = `${base}/router`;
let machine = 0; // the slot, from the control plane
let tunnelToken = "";
let agent = "";
let run = ""; // this start of the agent
// What this agent tells the control plane about its machine.
const describe = () => ({
  pool,
  poolSize: pool && env.POOL_SIZE ? Number(env.POOL_SIZE) : undefined, // how many machines the pool should have
  url: env.LINK || null,
  label: env.LABEL || hostname(),
  starts: Boolean(env.START_CMD),
});
// Commands run without secrets (anything named like a token, key or password), so a compose file can't read them.
const cleanEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/TOKEN|SECRET|PASSWORD|KEY/i.test(k)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

function sh(cmd, args, { timeout = 15 * 60_000, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 << 20, env: { ...cleanEnv, ...extraEnv } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

// How the control plane's Worker reaches a project on this machine (the public URLs name replicas, not machines).
const machineHost = (name) => `${name}-m${machine}.${domain}`;

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
    const { code, routed } = await probe(machineHost(name));
    if (code && routed && code !== 502) return true;
    if (Date.now() >= end) return false;
    await sleep(2000);
  }
}

// ---- projects ----

const projects = new Map(); // name -> { v, port, s: "applying" | "healthy" | "failed", e, busy, at, misses }
let domain = "";

async function apply(name, want) {
  const p = { v: want.v, port: want.port, s: "applying", e: "", busy: true, at: Date.now(), misses: 0 };
  projects.set(name, p);
  updateRouter();
  log(`${name}: starting v${want.v}`);
  let s = "healthy";
  let e = "";
  try {
    const projectDir = `${dir}/${name}`;
    const file = `${projectDir}/compose.yaml`;
    await mkdir(projectDir, { recursive: true });
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
    const up = await sh("docker", ["compose", "-p", name, "-f", file, "up", "-d", "--build", "--remove-orphans",
      "--wait", "--wait-timeout", "300"]);
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
    const retry = p?.s === "failed" && Date.now() - p.at > 3 * 60_000;
    if (!p || p.v !== want.v || p.port !== want.port || retry) apply(name, want).catch((e) => log(`${name}: ${e.message}`));
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
    if (p.busy || p.s !== "healthy" || !p.port) continue;
    if (await answers(name, 0)) {
      p.misses = 0;
    } else if (++p.misses >= 3) {
      log(`${name}: stopped answering on port ${p.port}; restarting it`);
      Object.assign(p, { s: "failed", e: `stopped answering on port ${p.port}`, at: 0, misses: 0 });
    }
  }
}

// ---- router (Caddy) and tunnel (cloudflared) ----

let routerChain = Promise.resolve();
let routerConfig = "";
// Queued so configs are applied in order.
const updateRouter = () => (routerChain = routerChain.then(loadRouter, loadRouter));

function routerJson() {
  const routes = [...projects]
    .filter(([, p]) => p.port && domain)
    .map(([name, p]) => ({
      match: [{ host: [machineHost(name)] }],
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

// ---- control plane ----

let ready = false;

const metrics = startMetrics();

// Get a slot and its tunnel token. Keeps trying: the control plane may be unreachable, or every slot taken.
async function join() {
  agent = env.AGENT_ID || "";
  if (!agent) {
    const idFile = `${base}/agent-id`;
    agent = (await readFile(idFile, "utf8").catch(() => "")).trim();
    if (!agent) {
      agent = `host-${randomUUID().slice(0, 8)}`;
      await writeFile(idFile, agent);
    }
  }
  run = `${agent}-${started}`;
  for (let wait = 5;; wait = Math.min(wait * 2, 60)) {
    try {
      const res = await fetch(`${env.CONTROL_URL}/api/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.JOIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ agent, ...describe(), want: env.MACHINE ? Number(env.MACHINE) : undefined }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      ({ machine, tunnelToken, domain } = data);
      return log(`joined as machine ${machine} (${agent})`);
    } catch (e) {
      log(`couldn't join (${e.message}); trying again in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

// After a restart: projects from last time that are no longer wanted.
async function removeLeftovers(desired) {
  for (const name of await readdir(dir).catch(() => [])) {
    if (name in desired || projects.has(name)) continue;
    log(`${name}: left over from before; removing`);
    await sh("docker", ["compose", "-p", name, "-f", `${dir}/${name}/compose.yaml`, "down", "--remove-orphans"]);
    await rm(`${dir}/${name}`, { recursive: true, force: true });
  }
}

async function sync() {
  const status = Object.fromEntries([...projects].map(([name, p]) => [name, { v: p.v, s: p.s, e: p.e || undefined }]));
  const sent = metrics.payload();
  const res = await fetch(`${env.CONTROL_URL}/api/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.JOIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ machine, run, agent, ...describe(), started, ready, status, leaving, metrics: sent }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  metrics.confirm(sent);
  return res.json();
}

// START_CMD with SLOT=m, and the agent's full environment: it may need a token the projects don't get.
function startMachine(m) {
  return new Promise((resolve) => {
    execFile("sh", ["-c", env.START_CMD], { timeout: 60_000, env: { ...env, SLOT: String(m) } }, (err, stdout, stderr) => {
      log(err ? `couldn't start machine ${m}: ${`${stdout}${stderr}`.trim().split("\n").pop() || err.message}` : `started machine ${m}`);
      resolve();
    });
  });
}

let stopping = false;
let leaving = false; // telling the control plane this run is going away for good (its replicas can be placed elsewhere now)
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`${reason}; stopping the tunnel`);
  // Under a supervisor (Docker's restart policy, say) the agent comes back with the same slot.
  await sh("docker", ["stop", "-t", "10", "tunnel"]);
  process.exit(code);
}
// Stopped from outside. A pool member is interchangeable, so that means it's going away for good: say so in one last
// check-in, so its replicas are placed elsewhere straight away. A standalone host is probably just restarting its
// agent and keeps them.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping || leaving) return;
    leaving = Boolean(pool);
    (leaving ? sync().catch(() => {}) : Promise.resolve()).finally(() => shutdown("cancelled"));
  });
}

async function main() {
  await mkdir(dir, { recursive: true });
  await join();
  log(`machine ${machine}: ${describe().label}${pool ? `, pool ${pool}` : ""}`);
  // Left from before a restart, maybe.
  await sh("docker", ["rm", "-f", "router", "tunnel"]);
  await startRouter();
  let cleaned = false;
  let successorAt = 0;
  let lastReport = 0;
  for (;;) {
    if (leaving) { // a signal handler is checking in for the last time; don't start anything meanwhile
      await sleep(1000);
      continue;
    }
    let plan = null;
    try {
      plan = await sync();
    } catch (e) {
      log(`control plane unreachable (${e.message}); keeping what's running`);
    }
    if (plan?.retire) return shutdown("a newer run of this machine is healthy, so this one is leaving");
    if (plan) {
      if (plan.domain !== domain) {
        domain = plan.domain;
        updateRouter();
      }
      reconcile(plan.desired);
      if (!cleaned) {
        cleaned = true;
        await removeLeftovers(plan.desired);
      }
      if (env.START_CMD) for (const m of plan.start ?? []) await startMachine(m);
      if (plan.handover && !env.START_CMD) return shutdown("handing over: restarting the agent");
      if (plan.handover && Date.now() - successorAt > 10 * 60_000) {
        successorAt = Date.now();
        log("handing over: starting a replacement for this machine");
        await startMachine(machine);
      }
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
}

main().catch((e) => shutdown(`agent failed: ${e.stack ?? e}`, 1));

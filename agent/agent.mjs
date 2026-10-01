// Runner agent: keeps one machine's projects in line with the control plane.
// It starts a local router and this machine's Cloudflare tunnel, checks in every few seconds, starts, updates
// and removes docker compose projects to match what it's told, restarts ones that stop answering, starts
// machines the control plane says are missing, and hands over to a fresh run before GitHub's 6-hour limit.
// No dependencies: Node's built-ins plus the docker CLI.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";

const env = process.env;
const machine = Number(env.MACHINE);
const run = env.GITHUB_RUN_ID;
const started = Date.now();
const hardStop = started + 355 * 60_000; // leave before GitHub kills the job at 6 hours
const selfHandover = started + 330 * 60_000; // start a replacement ourselves if the control plane hasn't asked by then
const settleBy = started + 10 * 60_000; // open the tunnel by then even if a project is still struggling
const ROUTER_PORT = 19080; // the tunnel sends everything here, and the router (Caddy) picks the project by hostname
const dir = `${env.RUNNER_TEMP}/projects`;
const routerDir = `${env.RUNNER_TEMP}/router`;
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
  const p = { v: want.v, port: want.port, s: "applying", e: "", busy: true, at: Date.now(), misses: 0 };
  projects.set(name, p);
  updateRouter();
  log(`${name}: starting v${want.v}`);
  const file = `${dir}/${name}/compose.yaml`;
  await mkdir(`${dir}/${name}`, { recursive: true });
  await writeFile(file, want.compose);
  // compose only recreates the containers whose config changed, and --wait fails if one won't stay up.
  const up = await sh("docker", ["compose", "-p", name, "-f", file, "up", "-d", "--build", "--remove-orphans",
    "--wait", "--wait-timeout", "300"]);
  let s = "healthy";
  let e = "";
  if (!up.ok) [s, e] = ["failed", up.out.split("\n").slice(-6).join("\n").slice(-600)];
  else if (want.port && !(await answers(name, 60))) [s, e] = ["failed", `nothing answers on port ${want.port} through the router`];
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
  await writeFile(`${env.RUNNER_TEMP}/tunnel.yml`, `ingress:\n  - service: http://127.0.0.1:${ROUTER_PORT}\n`);
  const r = await sh("docker", ["run", "-d", "--name", "tunnel", "--network", "host", "--restart", "unless-stopped",
    "-e", "TUNNEL_TOKEN", "-v", `${env.RUNNER_TEMP}/tunnel.yml:/etc/cloudflared/config.yml:ro`,
    "cloudflare/cloudflared:latest", "tunnel", "--no-autoupdate", "--config", "/etc/cloudflared/config.yml", "run"],
  { extraEnv: { TUNNEL_TOKEN: env.TUNNEL_TOKEN } });
  if (!r.ok) throw new Error(`tunnel didn't start: ${r.out}`);
  for (let i = 0; i < 45; i++) {
    if ((await sh("docker", ["logs", "tunnel"])).out.includes("Registered tunnel connection")) return log("tunnel online");
    await sleep(2000);
  }
  throw new Error(`tunnel didn't connect: ${(await sh("docker", ["logs", "--tail", "20", "tunnel"])).out}`);
}

// ---- control plane and GitHub ----

let ready = false;

async function sync() {
  const status = Object.fromEntries([...projects].map(([name, p]) => [name, { v: p.v, s: p.s, e: p.e || undefined }]));
  const res = await fetch(`${env.CONTROL_URL}/api/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ machine, run, started, ready, status }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function startMachine(m) {
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
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`${reason}; stopping the tunnel`);
  await sh("docker", ["stop", "-t", "10", "tunnel"]);
  process.exit(code);
}
process.on("SIGINT", () => shutdown("cancelled"));
process.on("SIGTERM", () => shutdown("cancelled"));

async function main() {
  log(`machine ${machine}, run ${run}`);
  await mkdir(dir, { recursive: true });
  await startRouter();
  let successorAt = 0;
  let lastReport = 0;
  while (Date.now() < hardStop) {
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
      for (const m of plan.start ?? []) await startMachine(m);
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
  await shutdown("reached the time limit");
}

main().catch((e) => shutdown(`agent failed: ${e.stack ?? e}`, 1));

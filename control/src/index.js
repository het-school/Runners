// Control plane for hetp4401/runner.
// Holds the project specs (a docker compose file plus any Dockerfiles and build files) and sends every change to all
// machines. Machines find it, not the other way round: any agent joins at /api/join, gets the lowest free slot n and
// the token for tunnel runner-<n> (created through the Cloudflare API the first time a slot is used), then checks in
// at /api/sync. The agent describes its machine; this never knows what's behind it:
//   pool     the name of a replaceable set it belongs to (members are started on request to keep the pool's size),
//            or none for a standalone host that keeps its slot across restarts
//   url      what to link to for it, and a label
//   leaving  on its last check-in, when it's going for good (its replicas are placed elsewhere at once)
// and whatever runs the machine pings POST /api/drain when it's going down soon (a timer in the GitHub workflow,
// a cron before maintenance, a cloud termination notice): the control plane then hands the machine over, one at a
// time, the same way as for a requested roll. Nothing here predicts lifetimes.
// It also keeps DNS in line: <project>-<n> points at tunnel runner-<n>, and <project> itself is served by this
// Worker, which passes each request on to a machine where the project is healthy.
//   /            public status page          /api/*        API, Bearer token (admin, or node for join/sync/claim)
//   /admin       admin portal (open)         /admin/api/*  the project API without a token
//   /metrics     metrics dashboard           /api/metrics  machine and app metrics (no token needed)
import { DurableObject } from "cloudflare:workers";
import YAML from "yaml";
import ADMIN_PAGE from "./admin.html";
import METRICS_PAGE from "./metrics.html";
import { STATUS_PAGE } from "./status-page.js";

const POLL_S = 20; // how often agents check in
const LIVE_MS = 75_000; // a run counts as up if it checked in this recently
const START_WAIT_MS = 8 * 60_000; // after starting a machine, give it this long to show up before trying again
const HANDOVER_STUCK_MS = 15 * 60_000; // a handover slower than this stops holding up the other machines
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE_PATH = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;
const MAX_FILES = 30;
const MAX_SPEC_BYTES = 256_000;
const STANDALONE_HOLD_MS = 30 * 60_000; // a standalone machine that drops out keeps its slot this long, so a restart gets the same one
const SHARED_DNS = "100::"; // <project>.DOMAIN is a proxied placeholder record; the Worker route answers it
const REPLICAS_ALL = 0; // stored value of replicas: "all"
const MAX_REPLICAS = 100;
const ARRIVAL_MS = 3 * 60_000; // after a (re)start, wait this long for the fleet and its metrics before placing anything
const MOVE_TIMEOUT_MS = 15 * 60_000; // a move's old copy is dropped once the new one is healthy, or after this long
// Automatic rebalancing: a machine that's hot (over these for HOT_MS straight) or that carries SPREAD_GAP more placed
// projects than the emptiest machine has one project moved off it, to a machine with room, at most one move per
// COOLDOWN_MS fleet-wide, and no project more than once per PROJECT_COOLDOWN_MS.
const HOT_CPU = 85;
const HOT_MEM = 90;
const ROOM_CPU = 70; // a destination must be under these
const ROOM_MEM = 80;
const SPREAD_GAP = 2;
const COOLDOWN_MS = 10 * 60_000;
const PROJECT_COOLDOWN_MS = 30 * 60_000;
const SETTLED_MS = 5 * 60_000; // a machine takes part once it's been up this long
// Metrics: agents send one summary per machine per minute; the fleet's minute is stored as one row (few writes),
// and rolled up into 10-minute rows for the longer views.
const MIN = 60_000;
const KEEP_1M_MS = 48 * 3600_000;
const KEEP_10M_MS = 30 * 24 * 3600_000;
const FLUSH_AFTER_MS = 150_000; // a minute is written once its summaries have had time to arrive
const RANGES = { // range -> [span, step, table]
  "1h": [3600_000, MIN, "metrics_1m"],
  "6h": [6 * 3600_000, 2 * MIN, "metrics_1m"],
  "24h": [24 * 3600_000, 10 * MIN, "metrics_10m"],
  "7d": [7 * 24 * 3600_000, 60 * MIN, "metrics_10m"],
  "30d": [30 * 24 * 3600_000, 240 * MIN, "metrics_10m"],
};

// Combines summaries of the same machine or app: averages, except <field>Max (peaks), which take the largest.
function mergeSummaries(list) {
  const sum = {};
  const cnt = {};
  for (const x of list) {
    for (const [k, v] of Object.entries(x ?? {})) {
      if (typeof v !== "number") continue;
      if (k.endsWith("Max")) sum[k] = Math.max(sum[k] ?? -Infinity, v);
      else {
        sum[k] = (sum[k] ?? 0) + v;
        cnt[k] = (cnt[k] ?? 0) + 1;
      }
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(sum)) {
    const x = cnt[k] ? v / cnt[k] : v;
    out[k] = Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100;
  }
  return out;
}

// { machine: { h, a: { app } } } rows of one bucket -> one { machine: { h, a } }.
function mergeFleet(rows) {
  const byMachine = {};
  for (const row of rows) for (const [m, x] of Object.entries(row)) (byMachine[m] ??= []).push(x);
  const out = {};
  for (const [m, list] of Object.entries(byMachine)) {
    const apps = {};
    for (const x of list) for (const [app, a] of Object.entries(x.a ?? {})) (apps[app] ??= []).push(a);
    out[m] = { h: mergeSummaries(list.map((x) => x.h)), a: Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, mergeSummaries(v)])) };
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => Response.json(data, { status });
const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const isMap = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// "./web/" + "Dockerfile" -> "web/Dockerfile"; null if it climbs out of the project folder.
function joinPath(...parts) {
  const out = [];
  for (const seg of parts.join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

// Turns what was submitted into a spec the machines can run: { compose, port, files }.
// Accepts a compose file, a Dockerfile, extra build files, or a mix; a Dockerfile on its own becomes a
// one-service compose file. Rejects anything that would only fail later on a machine.
function buildSpec(body) {
  if (!isMap(body)) throw new HttpError(400, "send a JSON object");
  let { compose = "", dockerfile = null, files = {}, port = null, replicas = null } = body;
  if (typeof compose !== "string") throw new HttpError(400, "compose must be the compose file as text");
  if (!isMap(files)) throw new HttpError(400, "files must be an object of path: content");
  files = { ...files };
  if (dockerfile !== null) {
    if (typeof dockerfile !== "string" || !dockerfile.trim()) throw new HttpError(400, "dockerfile must be the Dockerfile as text");
    files.Dockerfile = dockerfile;
  }
  if (Object.keys(files).length > MAX_FILES) throw new HttpError(400, `at most ${MAX_FILES} files`);
  let size = compose.length;
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") throw new HttpError(400, `${path} must be text`);
    if (!FILE_PATH.test(path) || joinPath(path) !== path) throw new HttpError(400, `${path} isn't a usable file path`);
    if (/^(docker-)?compose\.ya?ml$/.test(path)) throw new HttpError(400, "send the compose file as compose, not as a file");
    size += path.length + content.length;
  }
  if (size > MAX_SPEC_BYTES) throw new HttpError(400, "the spec is bigger than 250 KB");
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new HttpError(400, "port must be a whole number from 1 to 65535");
  }
  const parseReplicas = (x, where) => {
    if (x === null || x === undefined || x === "") return null;
    if (x === "all") return REPLICAS_ALL;
    const n = Number(x);
    if (!(Number.isInteger(n) && n >= 1 && n <= MAX_REPLICAS)) throw new HttpError(400, `${where} must be "all" or a whole number from 1 to ${MAX_REPLICAS}`);
    return n;
  };
  replicas = parseReplicas(replicas, "replicas");
  if (!compose.trim()) {
    if (!files.Dockerfile) throw new HttpError(400, "send a compose file, a Dockerfile, or both");
    // A Dockerfile on its own: build it and publish the port (the app should listen on it inside the container).
    compose = [
      ...(port || replicas !== null ? ["x-runner:"] : []),
      ...(port ? [`  port: ${port}`] : []),
      ...(replicas !== null ? [`  replicas: ${replicas === REPLICAS_ALL ? "all" : replicas}`] : []),
      "services:",
      "  app:",
      "    build: .",
      ...(port ? [`    ports: ["${port}:${port}"]`] : []),
      "    restart: unless-stopped",
      "",
    ].join("\n");
  }
  let doc;
  try {
    doc = YAML.parse(compose);
  } catch (e) {
    throw new HttpError(400, `the compose file isn't valid YAML: ${e.message.split("\n")[0]}`);
  }
  if (!isMap(doc) || !isMap(doc.services) || !Object.keys(doc.services).length) {
    throw new HttpError(400, "the compose file needs a services: section");
  }
  port ??= doc["x-runner"]?.port ?? null;
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new HttpError(400, "x-runner.port must be a whole number from 1 to 65535");
  }
  replicas ??= parseReplicas(doc["x-runner"]?.replicas, "x-runner.replicas") ?? 1;
  // Every service that builds from a local folder needs its Dockerfile among the files.
  for (const [service, def] of Object.entries(doc.services)) {
    if (!isMap(def) || def.build == null) continue;
    const build = isMap(def.build) ? def.build : { context: def.build };
    if (build.dockerfile_inline) continue;
    const context = String(build.context ?? ".");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith("git@")) continue; // a git repo or URL
    const dockerfile = joinPath(context, String(build.dockerfile ?? "Dockerfile"));
    if (dockerfile === null) throw new HttpError(400, `service ${service} builds from outside the project folder`);
    if (!(dockerfile in files)) {
      throw new HttpError(400, `service ${service} builds from ${dockerfile}, but no file with that path was sent`);
    }
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return { compose, port, replicas, files: sorted };
}

// ---- shared URLs: <project>.DOMAIN goes to a machine where the project is healthy ----

let routeCache = { at: 0, data: null, pending: null };
function healthyRoutes(env) {
  if (routeCache.data && Date.now() - routeCache.at < 5_000) return routeCache.data;
  routeCache.pending ??= env.CONTROL.get(env.CONTROL.idFromName("main")).fetch("https://control/internal/routes")
    .then((r) => r.json())
    .then((data) => {
      routeCache = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((e) => {
      routeCache.pending = null;
      if (routeCache.data) return routeCache.data;
      throw e;
    });
  return routeCache.pending;
}

// FNV-1a; with it each visitor sticks to one machine while that machine stays healthy.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

async function proxy(request, env, project) {
  const slots = (await healthyRoutes(env))[project];
  if (!slots?.length) {
    return new Response(`${project} isn't healthy on any machine right now\n`, { status: 503, headers: { "retry-after": "10" } });
  }
  const visitor = request.headers.get("cf-connecting-ip") ?? "";
  const order = slots.map((n) => [n, hash(`${visitor}|${n}`)]).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  // Requests without a body can try another machine when one doesn't answer.
  const retry = request.method === "GET" || request.method === "HEAD";
  const host = new URL(request.url).hostname;
  let res = null;
  for (const n of order.slice(0, retry ? 3 : 1)) {
    const url = new URL(request.url);
    url.hostname = `${project}-${n}.${env.DOMAIN}`;
    const req = new Request(url, request);
    req.headers.set("x-forwarded-host", host);
    try {
      res = await fetch(req, { redirect: "manual" });
    } catch {
      res = null;
      continue;
    }
    // The machine's router answers 404 with this header when it no longer has the project (it's being removed
    // there); the app never saw the request, so another machine can take it whatever the method.
    if (res.status === 404 && res.headers.get("x-runner-route") === "none") continue;
    if (retry && [502, 503, 504, 530].includes(res.status)) continue;
    // Keep visitors on the shared hostname when the app redirects to the machine's own one.
    const location = res.headers.get("location");
    if (location?.includes(url.hostname)) {
      res = new Response(res.body, res);
      res.headers.set("location", location.replace(url.hostname, host));
    }
    break;
  }
  return res ?? new Response("no machine answered\n", { status: 502 });
}

// Served at /install.sh: runs the agent in a container on any machine with Docker. The token isn't in it.
function installScript(origin) {
  return `#!/bin/sh
# Adds this machine to the runner fleet (https://github.com/hetp4401/runner). Needs Docker.
#   curl -fsSL ${origin}/install.sh | sudo JOIN_TOKEN=<token> sh
# The agent runs in the container runner-agent, takes a free slot n, and serves every project at
# https://<project>-n.<domain>. It fetches the latest agent code each time it starts.
# Remove the machine:  docker rm -f runner-agent tunnel router
set -eu
: "\${JOIN_TOKEN:?set JOIN_TOKEN; the fleet's owner gets it with: runnerctl join-token}"
DATA=\${RUNNER_DATA:-/var/lib/runner}
command -v docker >/dev/null 2>&1 || { echo "Install Docker first: https://docs.docker.com/engine/install/" >&2; exit 1; }
mkdir -p "$DATA"
docker rm -f runner-agent >/dev/null 2>&1 || true
docker run -d --name runner-agent --restart unless-stopped --stop-timeout 180 --network host --hostname "$(hostname)" \\
  -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA:$DATA" \\
  -e CONTROL_URL=${origin} -e CONTROL_TOKEN="$JOIN_TOKEN" -e RUNNER_DATA="$DATA" \\
  docker:cli sh -c '
    set -e
    apk add --no-cache nodejs >/dev/null
    sha=$(wget -qO- https://api.github.com/repos/hetp4401/runner/commits/main | grep -m1 "\\"sha\\"" | cut -d\\" -f4 || true)
    mkdir -p /agent && cd /agent
    for f in agent.mjs metrics.mjs; do wget -qO $f https://raw.githubusercontent.com/hetp4401/runner/\${sha:-main}/agent/$f; done
    exec node agent.mjs'
echo "Joined. Follow it with: docker logs -f runner-agent"
`;
}

export default {
  fetch(request, env) {
    const host = new URL(request.url).hostname;
    const suffix = `.${env.DOMAIN}`;
    if (host !== env.CONTROL_HOST && host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".")) {
      return proxy(request, env, host.slice(0, -suffix.length));
    }
    return env.CONTROL.get(env.CONTROL.idFromName("main")).fetch(request);
  },
};

export class Control extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const query of [
      `CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, version INTEGER NOT NULL, stable INTEGER,
         rollout INTEGER NOT NULL, halted TEXT, updated INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS versions (name TEXT NOT NULL, version INTEGER NOT NULL, compose TEXT NOT NULL,
         port INTEGER, created INTEGER NOT NULL, PRIMARY KEY (name, version))`,
      `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, machine INTEGER NOT NULL, started INTEGER NOT NULL,
         status TEXT NOT NULL, ready INTEGER NOT NULL, handover INTEGER NOT NULL, retire INTEGER NOT NULL,
         seen INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS starts (machine INTEGER PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS placements (name TEXT NOT NULL, machine INTEGER NOT NULL, since INTEGER NOT NULL,
         reason TEXT NOT NULL, leaving TEXT, PRIMARY KEY (name, machine))`,
      `CREATE TABLE IF NOT EXISTS slots (n INTEGER PRIMARY KEY, tunnel TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, slot INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT, joined INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS metrics_1m (t INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS metrics_10m (t INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
    ]) {
      this.sql.exec(query);
    }
    // Columns added after the first release.
    const columns = (table) => new Set(this.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (!columns("projects").has("enabled")) this.sql.exec("ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    if (!columns("versions").has("files")) this.sql.exec("ALTER TABLE versions ADD COLUMN files TEXT");
    if (!columns("versions").has("replicas")) this.sql.exec("ALTER TABLE versions ADD COLUMN replicas INTEGER");
    if (!columns("placements").has("leaving")) this.sql.exec("ALTER TABLE placements ADD COLUMN leaving TEXT");
    const runColumns = columns("runs");
    if (!runColumns.has("agent")) this.sql.exec("ALTER TABLE runs ADD COLUMN agent TEXT");
    if (!runColumns.has("kind")) this.sql.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT ''"); // no longer used
    if (!runColumns.has("label")) this.sql.exec("ALTER TABLE runs ADD COLUMN label TEXT");
    for (const col of ["pool TEXT", "url TEXT", "drain INTEGER"]) if (!runColumns.has(col.split(" ")[0])) this.sql.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
    if (!columns("agents").has("pool")) this.sql.exec("ALTER TABLE agents ADD COLUMN pool TEXT");
    // Working state lives in memory (the object is single-threaded); SQLite keeps it across restarts,
    // which happen whenever Cloudflare lets the object sleep.
    this.projects = new Map(this.all("SELECT * FROM projects").map((p) => [p.name, p]));
    this.runs = new Map(this.all("SELECT * FROM runs").map((r) => [r.id, { ...r, status: JSON.parse(r.status), savedSeen: r.seen }]));
    this.starts = new Map(this.all("SELECT machine, at FROM starts").map((s) => [s.machine, s.at]));
    this.startPools = new Map();
    this.poolAsks = new Map();
    this.settings = new Map(this.all("SELECT key, value FROM settings").map((s) => [s.key, s.value]));
    this.versions = new Map(); // "name@version" -> { compose, port, files }
    this.placements = new Map(); // project -> Map(machine -> { since, reason })
    for (const x of this.all("SELECT * FROM placements ORDER BY since")) {
      (this.placements.get(x.name) ?? this.placements.set(x.name, new Map()).get(x.name))
        .set(x.machine, { since: x.since, reason: x.reason, leaving: x.leaving ? JSON.parse(x.leaving) : null });
    }
    this.bootAt = Date.now();
    this.samples = new Map(); // machine -> [{ t, cpu, mem }] from the last few minutes, for spotting hot machines
    this.lastRebalance = 0;
    this.autoMoved = new Map(); // project -> when it was last moved automatically
    this.rebalanceLog = JSON.parse(this.settings.get("rebalance_log") ?? "[]");
    this.slots = new Map(this.all("SELECT n, tunnel, token FROM slots").map((x) => [x.n, x])); // slot -> its tunnel
    this.agents = new Map(this.all("SELECT * FROM agents").map((a) => [a.id, a])); // agent -> the slot it last had
    this.holds = new Map(); // slot -> { agent, at }: just given out at /join, not checked in yet
    this.tunnelJobs = new Map(); // slot -> promise, while its tunnel is being looked up or created
    this.lastCleanup = 0;
    this.liveMetrics = new Map(); // machine -> { run, t, h, a }, the newest sample from the run that speaks for it
    this.pendingMetrics = new Map(); // minute -> { machine: { h, a } }, not yet written
    this.lastRollup = 0;
    this.metricsCache = new Map(); // range -> { at, body }
    // A deploy of this Worker resets its routes to the ones in wrangler.toml, so put the shared ones back.
    this.scheduleDns();
    this.dnsError = null;
  }

  all(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }

  setSetting(key, value) {
    this.settings.set(key, String(value));
    this.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      String(value),
    );
  }

  // Pools and how many machines each should have running. Any pool can join: its members (and whatever watches it,
  // through /api/claim) say how big it should be. The POOLS setting (portal, runnerctl pool) overrides that, and the
  // POOLS var is the default for a pool nobody has given a size for.
  pools() {
    const fromEnv = typeof this.env.POOLS === "string" ? JSON.parse(this.env.POOLS || "{}") : this.env.POOLS ?? {};
    const out = { ...fromEnv, ...Object.fromEntries(this.poolAsks), ...JSON.parse(this.settings.get("pools") ?? "{}") };
    for (const r of this.runs.values()) if (r.pool && !(r.pool in out)) out[r.pool] = 0; // pools that showed up without a size
    return out;
  }

  // A pool's size as its joiners give it (kept in memory: members re-send it with every check-in).
  askPoolSize(pool, size) {
    const n = Number(size);
    if (pool && size != null && size !== "" && Number.isInteger(n) && n >= 0 && n <= this.maxSlots()) this.poolAsks.set(pool, n);
  }

  poolSize(pool) {
    return Number(this.pools()[pool] ?? 0);
  }

  // Machines expected to be up: every pool's size (standalone machines come and go as they please).
  expectedMachines() {
    return Object.values(this.pools()).reduce((a, b) => a + Number(b), 0);
  }

  maxSlots() {
    return Number(this.env.MAX_SLOTS ?? 50);
  }

  live(run, now) {
    return now - run.seen < LIVE_MS;
  }

  liveRuns(now) {
    return [...this.runs.values()].filter((r) => !r.retire && this.live(r, now));
  }

  version(name, v) {
    const key = `${name}@${v}`;
    if (!this.versions.has(key)) {
      const row = this.all("SELECT compose, port, files, replicas FROM versions WHERE name = ? AND version = ?", name, v)[0];
      this.versions.set(key, row && { compose: row.compose, port: row.port, replicas: row.replicas ?? 1, files: JSON.parse(row.files ?? "{}") });
    }
    return this.versions.get(key);
  }

  saveProject(p) {
    this.projects.set(p.name, p);
    this.sql.exec(
      `INSERT INTO projects (name, version, stable, rollout, halted, updated, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET version = excluded.version, stable = excluded.stable,
         rollout = excluded.rollout, halted = excluded.halted, updated = excluded.updated, enabled = excluded.enabled`,
      p.name, p.version, p.stable, p.rollout, p.halted, p.updated, p.enabled,
    );
  }

  saveRun(r) {
    this.runs.set(r.id, r);
    r.savedSeen = r.seen;
    this.sql.exec(
      `INSERT INTO runs (id, machine, started, status, ready, handover, retire, seen, agent, kind, label, pool, url, drain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, ready = excluded.ready, handover = excluded.handover,
         retire = excluded.retire, seen = excluded.seen, label = excluded.label, pool = excluded.pool, url = excluded.url, drain = excluded.drain`,
      r.id, r.machine, r.started, JSON.stringify(r.status), r.ready, r.handover, r.retire, r.seen, r.agent, "", r.label, r.pool ?? null, r.url ?? null, r.drain ?? 0,
    );
  }

  markStart(machine, at, by, pool) {
    this.starts.set(machine, at);
    this.startPools.set(machine, pool); // in memory only: after a restart claims wait for runs to re-identify anyway
    this.sql.exec(
      "INSERT INTO starts (machine, at, by) VALUES (?, ?, ?) ON CONFLICT (machine) DO UPDATE SET at = excluded.at, by = excluded.by",
      machine, at, by,
    );
  }

  // ---- HTTP ----

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/") return html(STATUS_PAGE);
      if (request.method === "GET" && path === "/admin") return html(ADMIN_PAGE);
      if (request.method === "GET" && path === "/metrics") return html(METRICS_PAGE);
      if (request.method === "GET" && path === "/install.sh") return new Response(installScript(url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (request.method === "GET" && path === "/internal/routes") return json(this.healthyRoutes(Date.now()));
      if (path.startsWith("/admin/api/")) {
        // The portal is open to anyone with the URL (no sign-in); only refuse changes sent from other sites.
        const origin = request.headers.get("origin");
        if (request.method !== "GET" && origin && origin !== url.origin) throw new HttpError(403, "cross-site request refused");
        // No machine powers here (joining, checking in): those hand out tunnel tokens and project specs.
        return await this.api(request, url, path.slice("/admin/api".length), { admin: true, node: false, portal: true });
      }
      if (path.startsWith("/api/")) {
        const auth = request.headers.get("authorization") ?? "";
        const admin = Boolean(this.env.ADMIN_TOKEN) && auth === `Bearer ${this.env.ADMIN_TOKEN}`;
        const node = admin || (Boolean(this.env.NODE_TOKEN) && auth === `Bearer ${this.env.NODE_TOKEN}`);
        return await this.api(request, url, path.slice("/api".length), { admin, node });
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      return json({ error: e.message }, e.status ?? 500);
    }
  }

  async api(request, url, route, { admin, node, portal = false }) {
    const { method } = request;
    const body = () => request.json().catch(() => {
      throw new HttpError(400, "the body must be JSON");
    });
    const need = (ok) => {
      if (!ok) throw new HttpError(401, "bad token");
    };
    if (method === "GET" && route === "/status") return json(this.status());
    if (method === "GET" && route === "/metrics") return this.metricsResponse(url.searchParams.get("range") ?? "1h");
    if (method === "POST" && route === "/join") return need(node), json(await this.join(await body()));
    if (method === "POST" && route === "/sync") return need(node), json(this.sync(await body()));
    if (method === "POST" && route === "/claim") {
      need(node);
      const pool = url.searchParams.get("pool");
      this.askPoolSize(pool, url.searchParams.get("size"));
      return json({ start: this.claimStarts(pool, "claim", Date.now()) });
    }
    if (method === "POST" && route === "/drain") return need(node), json(this.drain(await body()));
    if (method === "POST" && route === "/roll") return need(admin || node), json(this.roll(url.searchParams.get("machine")));
    // The token a new host joins with; only with the admin token itself, never through the open portal.
    if (method === "GET" && route === "/join-token") return need(admin && !portal), json({ token: this.env.NODE_TOKEN });
    if (method === "PUT" && route === "/settings") return need(admin), json(this.putSettings(await body()));
    const ev = route.match(/^\/machines\/(\d+)\/evict$/);
    if (ev && method === "POST") return need(admin), json(this.evict(Number(ev[1])));
    const sl = route.match(/^\/slots\/(\d+)$/);
    if (sl && method === "DELETE") return need(admin), json(await this.retireSlot(Number(sl[1])));
    const m = route.match(/^\/projects\/([^/]+)(?:\/(enable|disable|move))?$/);
    if (m) {
      need(admin);
      const [, name, action] = m;
      if (action === "move" && method === "POST") return json(this.move(name, Number(url.searchParams.get("from")), url.searchParams.get("to")));
      if (action && method === "POST") return json(this.setEnabled(name, action === "enable"));
      if (!action && method === "GET") return json(this.getProject(name, url.searchParams.get("version")));
      if (!action && method === "PUT") return json(this.putProject(name, await body()));
      if (!action && method === "DELETE") return json(this.deleteProject(name));
    }
    throw new HttpError(404, "not found");
  }


  // ---- projects ----

  describe(p) {
    const latest = this.version(p.name, p.version);
    const replicas = latest?.replicas ?? 1;
    const placed = [...(this.placements.get(p.name) ?? [])].map(([machine, x]) => ({ machine, ...x })).sort((a, b) => a.machine - b.machine);
    const staying = placed.filter((x) => !x.leaving).length;
    return {
      name: p.name,
      version: p.version,
      stable: p.stable,
      port: latest?.port ?? null,
      replicas: replicas === REPLICAS_ALL ? "all" : replicas,
      placed, // the machines it's placed on (empty when replicas is "all": then it's every machine); leaving = being moved away
      staying,
      files: Object.keys(latest?.files ?? {}),
      enabled: Boolean(p.enabled),
      state: !p.enabled ? "disabled" : p.halted ? "halted" : p.stable === p.version ? "live" : "deploying",
      halted: p.halted,
      updated: p.updated,
    };
  }

  project(name) {
    const p = this.projects.get(name);
    if (!p) throw new HttpError(404, `no project called ${name}`);
    return p;
  }

  getProject(name, versionParam) {
    const p = this.project(name);
    const v = versionParam ? Number(versionParam) : p.version;
    const spec = this.version(name, v);
    if (!spec) throw new HttpError(404, `${name} has no version ${versionParam}`);
    return {
      ...this.describe(p),
      shown: v,
      compose: spec.compose,
      files: spec.files,
      port: spec.port,
      replicas: spec.replicas === REPLICAS_ALL ? "all" : spec.replicas,
      versions: this.all("SELECT version, port, replicas, created FROM versions WHERE name = ? ORDER BY version", name)
        .map((v) => ({ ...v, replicas: (v.replicas ?? 1) === REPLICAS_ALL ? "all" : v.replicas ?? 1 })),
    };
  }

  // A new spec becomes a new version, which goes to every machine at once.
  putProject(name, body) {
    if (!NAME.test(name)) throw new HttpError(400, "project names are lowercase letters, digits and dashes");
    const spec = buildSpec(body);
    const t = Date.now();
    const machines = this.expectedMachines();
    const p = this.projects.get(name);
    const latest = p && this.version(name, p.version);
    const same = latest && latest.compose === spec.compose && latest.port === spec.port && latest.replicas === spec.replicas &&
      JSON.stringify(latest.files) === JSON.stringify(spec.files);
    let next;
    if (same) {
      // Same spec again: a no-op, unless the version hasn't reached every machine yet (then push it there).
      if (!p.halted && p.stable === p.version) return { ...this.describe(p), unchanged: true };
      next = { ...p, halted: null, rollout: machines, stable: p.version, updated: t };
    } else {
      const version = (p?.version ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO versions (name, version, compose, port, files, replicas, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
        name, version, spec.compose, spec.port, JSON.stringify(spec.files), spec.replicas, t,
      );
      next = {
        name, version, stable: version, rollout: machines, halted: null,
        updated: t, enabled: p?.enabled ?? 1,
      };
    }
    this.saveProject(next);
    this.place(t);
    this.scheduleDns();
    return this.describe(next);
  }

  // Disabled projects stay in the list with their versions, but no machine runs them.
  setEnabled(name, enabled) {
    const p = this.project(name);
    this.saveProject({ ...p, enabled: enabled ? 1 : 0, updated: Date.now() });
    this.place(Date.now());
    return this.describe(this.projects.get(name));
  }

  deleteProject(name) {
    this.project(name);
    this.projects.delete(name);
    this.sql.exec("DELETE FROM projects WHERE name = ?", name);
    this.sql.exec("DELETE FROM versions WHERE name = ?", name);
    this.sql.exec("DELETE FROM placements WHERE name = ?", name);
    this.placements.delete(name);
    for (const key of this.versions.keys()) if (key.startsWith(`${name}@`)) this.versions.delete(key);
    this.scheduleDns();
    return { deleted: name };
  }

  putSettings(body) {
    const { pools, rebalance } = isMap(body) ? body : {};
    if (rebalance !== undefined) {
      if (typeof rebalance !== "boolean") throw new HttpError(400, "rebalance must be true or false");
      this.setSetting("rebalance", rebalance ? "on" : "off");
    }
    if (pools !== undefined) {
      if (!isMap(pools)) throw new HttpError(400, 'pools must be an object of pool name to size, like {"name": 10}');
      const next = { ...JSON.parse(this.settings.get("pools") ?? "{}") };
      for (const [name, size] of Object.entries(pools)) {
        if (!/^[a-z0-9-]{1,30}$/.test(name)) throw new HttpError(400, "a pool name is lowercase letters, digits and dashes");
        if (!(Number.isInteger(size) && size >= 0 && size <= this.maxSlots())) throw new HttpError(400, `a pool's size is 0-${this.maxSlots()}`);
        next[name] = size;
      }
      this.setSetting("pools", JSON.stringify(next));
      this.scheduleDns();
    }
    return { pools: this.pools(), rebalance: this.rebalanceOn() };
  }

  rebalanceOn() {
    return this.settings.get("rebalance") !== "off";
  }

  hotMs() {
    return Number(this.env.HOT_MS ?? 5 * 60_000);
  }

  // Replace machines one at a time (all of them, or just one), e.g. after the agent code changes.
  roll(machine) {
    const now = Date.now();
    this.setSetting(machine ? `roll_${Number(machine)}` : "roll", now);
    return { rolling: machine ? [Number(machine)] : "all", since: now };
  }

  // What machine n should run: every enabled project placed on it (or placed everywhere), at its latest version,
  // or the last good one if the latest is halted. Disabled projects run nowhere.
  desiredFor(machine) {
    const out = {};
    for (const p of this.projects.values()) {
      if (!p.enabled || !this.runsOn(p.name, machine)) continue;
      const v = p.halted ? p.stable : p.version;
      if (v == null) continue;
      const { compose, port, files } = this.version(p.name, v);
      out[p.name] = { v, compose, port, files };
    }
    return out;
  }

  runsOn(name, machine) {
    const p = this.projects.get(name);
    const replicas = this.version(name, p.version)?.replicas ?? 1;
    return replicas === REPLICAS_ALL || Boolean(this.placements.get(name)?.has(machine));
  }

  // A version is good once every machine that should run it (and is up) reports it healthy, and halted as soon
  // as one reports it failed; then every machine goes back to the last good version.
  settle(now) {
    const newest = new Map(); // machine -> its newest run that's up; that's the one that speaks for the machine
    for (const r of this.liveRuns(now)) {
      if ((newest.get(r.machine)?.started ?? -1) < r.started) newest.set(r.machine, r);
    }
    for (const p of this.projects.values()) {
      if (!p.enabled || p.halted || p.stable === p.version) continue;
      const group = [...newest.values()].filter((r) => this.runsOn(p.name, r.machine));
      if (!group.length) continue;
      const failed = group.find((r) => r.status[p.name]?.v === p.version && r.status[p.name]?.s === "failed");
      if (failed) p.halted = `machine ${failed.machine}: ${failed.status[p.name].e || "failed"}`.slice(0, 600);
      else if (group.every((r) => r.status[p.name]?.v === p.version && r.status[p.name]?.s === "healthy")) p.stable = p.version;
      else continue;
      p.updated = now;
      this.saveProject(p);
    }
  }

  // ---- placement ----
  // A project with N replicas runs on N machines. New replicas go to the machine with the most room: the least CPU
  // and memory in use (from its latest metrics) and the fewest projects already placed on it. A placement stays
  // where it is until that machine is gone; then the replica moves to the best machine left.

  savePlacement(name, machine, x) {
    (this.placements.get(name) ?? this.placements.set(name, new Map()).get(name)).set(machine, x);
    this.sql.exec("INSERT OR REPLACE INTO placements (name, machine, since, reason, leaving) VALUES (?, ?, ?, ?, ?)",
      name, machine, x.since, x.reason, x.leaving ? JSON.stringify(x.leaving) : null);
  }

  dropPlacement(name, machine) {
    this.placements.get(name)?.delete(machine);
    this.sql.exec("DELETE FROM placements WHERE name = ? AND machine = ?", name, machine);
  }

  // How busy a machine is, for choosing between them; lower is better. Without metrics (an agent that's just
  // started) it counts as half busy, so a machine that's measured and quiet wins.
  load(machine, placedCount, now) {
    const m = this.liveMetrics.get(machine);
    const fresh = m && now - m.t < 3 * LIVE_MS;
    const cpu = fresh ? m.h.cpu : 50;
    const mem = fresh && m.h.memTotal ? (100 * m.h.memUsed) / m.h.memTotal : 50;
    return { score: cpu + mem + 30 * placedCount, reason: fresh ? `cpu ${Math.round(cpu)}%, memory ${Math.round(mem)}%, ${placedCount} other project${placedCount === 1 ? "" : "s"}` : "no metrics yet" };
  }

  place(now) {
    const up = this.liveMachines(now); // machine -> its newest live run
    let changed = false;
    // After a (re)start the first machine to check in would get every replica, because it's the only one with
    // metrics; wait until every machine that's up has reported some (or 3 minutes).
    const measured = (machine) => now - (this.liveMetrics.get(machine)?.t ?? 0) < 3 * LIVE_MS;
    const arrived = now - this.bootAt > ARRIVAL_MS || (up.size >= this.expectedMachines() && [...up.keys()].every(measured));
    const counts = new Map(); // machine -> projects placed on it
    for (const [name, placed] of this.placements) {
      // Projects that are gone, disabled or "all" need no placements; neither do machines that have gone.
      const p = this.projects.get(name);
      const replicas = p ? this.version(name, p.version)?.replicas ?? 1 : null;
      for (const [machine, x] of placed) {
        // A copy being moved away goes once its replacement is healthy, or after a while regardless.
        const moved = x.leaving && (up.get(x.leaving.to)?.status[name]?.s === "healthy" || now - x.leaving.at > MOVE_TIMEOUT_MS);
        if (!p || !p.enabled || replicas === REPLICAS_ALL || !up.has(machine) || moved) {
          this.dropPlacement(name, machine);
          changed = true;
        } else if (!x.leaving) counts.set(machine, (counts.get(machine) ?? 0) + 1);
      }
    }
    for (const p of [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!p.enabled) continue;
      const want = this.version(p.name, p.version)?.replicas ?? 1;
      if (want === REPLICAS_ALL) continue;
      const placed = this.placements.get(p.name) ?? this.placements.set(p.name, new Map()).get(p.name);
      // Copies being moved away don't count; the move's new copy does.
      const staying = [...placed].filter(([, x]) => !x.leaving);
      // Too many (replicas were lowered): keep the oldest placements, and healthy ones over failed ones.
      const extra = staying.map(([machine, x]) => ({ machine, x, healthy: up.get(machine)?.status[p.name]?.s === "healthy" }))
        .sort((a, b) => a.healthy - b.healthy || b.x.since - a.x.since).slice(0, Math.max(0, staying.length - want));
      for (const { machine } of extra) {
        this.dropPlacement(p.name, machine);
        counts.set(machine, counts.get(machine) - 1);
        changed = true;
      }
      // Too few: the machines with the most room, ready ones first.
      for (let n = staying.length - extra.length; n < want && arrived; n++) {
        const best = this.bestMachine(p.name, up, counts, now);
        if (!best) break; // every machine already has one; the rest get placed when machines show up
        this.savePlacement(p.name, best.machine, { since: now, reason: best.reason, leaving: null });
        counts.set(best.machine, (counts.get(best.machine) ?? 0) + 1);
        changed = true;
      }
    }
    return changed;
  }

  // The machine with the most room that doesn't already run the project, ready ones first.
  bestMachine(name, up, counts, now) {
    const placed = this.placements.get(name) ?? new Map();
    return [...up.values()].filter((r) => !placed.has(r.machine))
      .map((r) => ({ machine: r.machine, ready: r.ready, ...this.load(r.machine, counts.get(r.machine) ?? 0, now) }))
      .sort((a, b) => b.ready - a.ready || a.score - b.score)[0] ?? null;
  }

  liveMachines(now) {
    const up = new Map();
    for (const r of this.liveRuns(now)) if ((up.get(r.machine)?.started ?? -1) < r.started) up.set(r.machine, r);
    return up;
  }

  placementCounts() {
    const counts = new Map();
    for (const placed of this.placements.values()) for (const [machine, x] of placed) if (!x.leaving) counts.set(machine, (counts.get(machine) ?? 0) + 1);
    return counts;
  }

  // Move one copy of a project off a machine: the new copy is placed first, and the old one is dropped once the
  // new one is healthy (see place()). `to` picks the destination; otherwise it's the machine with the most room.
  move(name, from, to) {
    const p = this.project(name);
    const now = Date.now();
    const placed = this.placements.get(name);
    const x = placed?.get(from);
    if (!x) throw new HttpError(400, `${name} isn't placed on machine ${from}`);
    if (x.leaving) throw new HttpError(409, `${name} is already moving from machine ${from} to ${x.leaving.to}`);
    const up = this.liveMachines(now);
    let dest;
    if (to) {
      dest = Number(to);
      if (!up.has(dest)) throw new HttpError(400, `machine ${to} isn't up`);
      if (placed.has(dest)) throw new HttpError(400, `${name} already runs on machine ${to}`);
      dest = { machine: dest, reason: `moved here from machine ${from} by hand` };
    } else {
      const best = this.bestMachine(name, up, this.placementCounts(), now);
      if (!best) throw new HttpError(409, `no other machine is up for ${name}`);
      dest = { machine: best.machine, reason: `moved here from machine ${from}: ${best.reason}` };
    }
    this.savePlacement(name, dest.machine, { since: now, reason: dest.reason, leaving: null });
    this.savePlacement(name, from, { ...x, leaving: { to: dest.machine, at: now } });
    return this.describe(p);
  }

  // Move every copy off a machine (it's hot, or about to be removed).
  evict(machine) {
    const moved = [];
    const failed = [];
    for (const [name, placed] of this.placements) {
      if (!placed.has(machine) || placed.get(machine).leaving) continue;
      try {
        this.move(name, machine, null);
        moved.push(name);
      } catch (e) {
        failed.push(`${name}: ${e.message}`);
      }
    }
    return { machine, moved, failed };
  }

  // ---- automatic rebalancing ----

  // Over the limits on every sample going back at least HOT_MS, with enough samples to mean it.
  isHot(machine, now) {
    const list = (this.samples.get(machine) ?? []).filter((x) => now - x.t <= this.hotMs() * 1.5);
    if (list.length < 3 || now - list[0].t < this.hotMs()) return false;
    return list.every((x) => x.cpu > HOT_CPU || x.mem > HOT_MEM);
  }

  hasRoom(machine, now) {
    const m = this.liveMetrics.get(machine);
    if (!m || now - m.t > 3 * LIVE_MS || !m.h.memTotal) return false;
    return m.h.cpu < ROOM_CPU && (100 * m.h.memUsed) / m.h.memTotal < ROOM_MEM;
  }

  // The placed (movable) project using the most of a machine, by its own CPU and memory there.
  heaviestOn(machine, now) {
    const m = this.liveMetrics.get(machine);
    const memTotal = m?.h.memTotal || 1;
    let best = null;
    for (const [name, placed] of this.placements) {
      const x = placed.get(machine);
      if (!x || x.leaving) continue;
      const spec = this.version(name, this.projects.get(name)?.version);
      if ((spec?.replicas ?? 1) === REPLICAS_ALL) continue;
      if (now - (this.autoMoved.get(name) ?? 0) < PROJECT_COOLDOWN_MS) continue;
      const a = m?.a[name];
      const weight = a ? (a.cpu || 0) + (100 * (a.mem || 0)) / memTotal : 0;
      if (!best || weight > best.weight) best = { name, weight };
    }
    return best;
  }

  logRebalance(now, text) {
    this.rebalanceLog.unshift({ t: now, text });
    this.rebalanceLog.length = Math.min(this.rebalanceLog.length, 30);
    this.setSetting("rebalance_log", JSON.stringify(this.rebalanceLog));
  }

  rebalance(now) {
    if (!this.rebalanceOn() || now - this.lastRebalance < 30_000) return;
    this.lastRebalance = now;
    if (now - (this.rebalanceLog[0]?.t ?? 0) < COOLDOWN_MS) return;
    // One move at a time: wait for any move (by hand or automatic) to finish.
    for (const placed of this.placements.values()) for (const x of placed.values()) if (x.leaving) return;
    const up = this.liveMachines(now);
    const settled = [...up.values()].filter((r) => r.ready && now - r.started > SETTLED_MS && this.liveMetrics.has(r.machine));
    if (settled.length < 2) return;
    const counts = this.placementCounts();
    // Hot machines first, busiest first; then the most loaded machine if the spread is uneven.
    let from = null;
    let why = "";
    const hot = settled.filter((r) => this.isHot(r.machine, now) && (counts.get(r.machine) ?? 0) > 0)
      .sort((a, b) => this.liveMetrics.get(b.machine).h.cpu - this.liveMetrics.get(a.machine).h.cpu);
    if (hot.length) {
      from = hot[0].machine;
      const h = this.liveMetrics.get(from).h;
      why = `machine ${from} is hot (cpu ${Math.round(h.cpu)}%, memory ${Math.round((100 * h.memUsed) / h.memTotal)}%)`;
    } else {
      const byCount = settled.map((r) => ({ machine: r.machine, n: counts.get(r.machine) ?? 0 })).sort((a, b) => b.n - a.n);
      const most = byCount[0];
      const least = byCount[byCount.length - 1];
      if (most.n - least.n < SPREAD_GAP) return;
      from = most.machine;
      why = `machine ${from} has ${most.n} projects, machine ${least.machine} has ${least.n}`;
    }
    const pick = this.heaviestOn(from, now);
    if (!pick) return;
    const dest = this.bestMachine(pick.name, new Map([...up].filter(([m]) => this.hasRoom(m, now) && settled.some((r) => r.machine === m))), counts, now);
    if (!dest) {
      if (now - (this.rebalanceLog[0]?.t ?? 0) > COOLDOWN_MS * 3) this.logRebalance(now, `${why}, but no machine has room for ${pick.name}`);
      return;
    }
    try {
      this.move(pick.name, from, String(dest.machine));
      const x = this.placements.get(pick.name).get(dest.machine);
      x.reason = `moved here from machine ${from} automatically: ${why}; ${dest.reason}`;
      this.savePlacement(pick.name, dest.machine, x);
      this.autoMoved.set(pick.name, now);
      this.logRebalance(now, `moved ${pick.name} from machine ${from} to machine ${dest.machine}: ${why}`);
    } catch (e) {
      this.logRebalance(now, `couldn't move ${pick.name} off machine ${from}: ${e.message}`);
    }
  }

  // ---- machines ----

  sync(body) {
    const now = Date.now();
    const machine = Number(body?.machine);
    const started = Number(body?.started);
    const run = String(body?.run ?? "");
    if (!Number.isInteger(machine) || machine < 1 || !run || !Number.isFinite(started)) {
      throw new HttpError(400, "machine, run and started are required");
    }
    const status = isMap(body.status) ? body.status : {};
    const ready = body.ready ? 1 : 0;
    // How the agent describes its machine (see the top of this file).
    const pool = typeof body.pool === "string" && /^[a-z0-9-]{1,30}$/.test(body.pool) ? body.pool : null;
    const url = typeof body.url === "string" && /^https:\/\/[^\s"<>]{1,300}$/.test(body.url) ? body.url : null;
    const label = String(body.label ?? "").slice(0, 80) || null;
    this.askPoolSize(pool, body.poolSize);
    let r = this.runs.get(run);
    if (!r) {
      const agent = String(body.agent ?? run).slice(0, 100);
      r = { id: run, machine, started, status, ready, handover: 0, retire: 0, seen: now, agent, label, pool, url, drain: 0 };
      this.saveRun(r);
    } else {
      const changed = ready !== r.ready || JSON.stringify(status) !== JSON.stringify(r.status) ||
        pool !== (r.pool ?? null) || url !== (r.url ?? null) || label !== (r.label ?? null);
      Object.assign(r, { status, ready, seen: now, pool, url, label });
      // Write when something changed, and "last seen" at most every 30s, to keep storage writes low.
      if (changed || now - r.savedSeen > 30_000) this.saveRun(r);
    }
    this.takeMetrics(r, body.metrics, now);
    if (body.leaving && !r.retire) {
      r.retire = 1; // going away for good: its replicas can be placed elsewhere right now
      this.saveRun(r);
    }
    this.place(now);
    this.settle(now);
    this.rebalance(now);
    if (!r.retire && (this.surplusInPool(r, now) || this.superseded(r, now))) {
      r.retire = 1;
      this.saveRun(r);
    }
    const handover = !r.retire && this.wantsHandover(r, now);
    const start = !r.retire && r.ready && r.pool ? this.claimStarts(r.pool, run, now) : []; // pool members start their peers
    this.cleanup(now);
    return {
      domain: this.env.DOMAIN,
      poll: POLL_S,
      desired: r.retire ? {} : this.desiredFor(r.machine),
      retire: Boolean(r.retire),
      handover,
      start,
    };
  }

  // A run can go once a newer run of the same machine is online and healthy on everything it should run.
  superseded(r, now) {
    return this.liveRuns(now).some((x) => x.machine === r.machine && x.started > r.started && x.ready &&
      Object.entries(this.desiredFor(x.machine)).every(([name, d]) => x.status[name]?.v === d.v && x.status[name]?.s === "healthy"));
  }

  // "This machine is going down soon": from whatever runs it. Its handover is scheduled like a requested roll.
  drain(body) {
    const now = Date.now();
    const runId = body?.run != null ? String(body.run) : null;
    const machine = Number(body?.machine);
    const runs = [...this.runs.values()].filter((x) => this.live(x, now) && !x.retire &&
      ((runId && x.id === runId) || (Number.isInteger(machine) && x.machine === machine)));
    if (!runs.length) throw new HttpError(404, "no live run matches that run or machine");
    for (const x of runs) {
      if (!x.drain) {
        x.drain = now;
        this.saveRun(x);
      }
    }
    return { draining: runs.map((x) => ({ run: x.id, machine: x.machine })) };
  }

  // Ask a run to start its own replacement when it's been told it's going down (or a roll was requested). One
  // machine at a time, oldest first, so at most one machine is ever changing over.
  wantsHandover(r, now) {
    const rollAll = Number(this.settings.get("roll") ?? 0);
    const due = (x) => Boolean(x.drain) || x.started < rollAll || x.started < Number(this.settings.get(`roll_${x.machine}`) ?? 0);
    if (!due(r)) return false;
    const live = this.liveRuns(now);
    const hasSuccessor = (x) => live.some((y) => y.machine === x.machine && y.started > x.started);
    if (hasSuccessor(r)) return false; // its replacement is already starting up
    if (r.handover) return true; // keep asking until a replacement shows up
    if (live.some((x) => x.handover && now - x.handover < HANDOVER_STUCK_MS)) return false;
    const next = live.filter((x) => due(x) && !hasSuccessor(x)).sort((a, b) => a.started - b.started)[0];
    if (next?.id !== r.id) return false;
    r.handover = now;
    this.saveRun(r);
    return true;
  }

  // Machines to start so a pool has its size. Whoever asks (a member of the pool, or something watching it from
  // outside through /api/claim) starts them, each with the slot it should take; the slot is held until it shows up.
  claimStarts(pool, by, now) {
    if (!pool || !(pool in this.pools())) return [];
    const live = this.liveRuns(now);
    // Just after a (re)start, runs loaded from storage haven't said which pool they're in yet; claiming then would
    // start a whole pool's worth of extras. Give them a couple of check-ins (a cold start has no live runs to wait for).
    if (now - this.bootAt < 2 * LIVE_MS && live.some((x) => now - x.seen > now - this.bootAt)) return [];
    const members = new Set(live.filter((x) => x.pool === pool).map((x) => x.machine));
    // Only this pool's starts count (a start from before a restart, pool unknown, counts for every pool).
    const starting = [...this.starts].filter(([n, at]) => now - at < START_WAIT_MS && !live.some((x) => x.machine === n) &&
      (this.startPools.get(n) ?? pool) === pool).length;
    const out = [];
    for (let missing = this.poolSize(pool) - members.size - starting; missing > 0; missing--) {
      const n = this.freeSlot(now, null);
      if (!n) break;
      this.markStart(n, now, by, pool);
      out.push(n);
    }
    return out;
  }

  // A pool's runs beyond its size: the ones in the highest slots go.
  surplusInPool(r, now) {
    if (!r.pool) return false;
    const slots = [...new Set(this.liveRuns(now).filter((x) => x.pool === r.pool).map((x) => x.machine))].sort((a, b) => a - b);
    return slots.indexOf(r.machine) >= this.poolSize(r.pool);
  }

  // A slot is taken while another agent runs in it, while a machine is starting for it, and for a while after a
  // standalone machine drops out (so it gets the slot back when it restarts).
  slotTaken(n, now, agent) {
    if (now - (this.starts.get(n) ?? 0) < START_WAIT_MS) return true;
    const hold = this.holds.get(n);
    if (hold && hold.agent !== agent && now - hold.at < 2 * 60_000) return true;
    return [...this.runs.values()].some((x) => x.machine === n && x.agent !== agent && !x.retire &&
      (this.live(x, now) || (!x.pool && now - x.seen < STANDALONE_HOLD_MS)));
  }

  freeSlot(now, agent) {
    for (let n = 1; n <= this.maxSlots(); n++) if (!this.slotTaken(n, now, agent)) return n;
    return null;
  }

  // An agent starting up: give it a slot and that slot's tunnel token. A machine started for a slot asks for it
  // (`want`); otherwise it gets the slot its agent had last time if that's still free, else the lowest free one.
  async join(body) {
    const now = Date.now();
    const agent = String(body?.agent ?? "");
    if (!agent || agent.length > 100) throw new HttpError(400, "agent (an ID for this agent) is required");
    const pool = typeof body.pool === "string" && /^[a-z0-9-]{1,30}$/.test(body.pool) ? body.pool : null;
    const label = String(body.label ?? "").slice(0, 80) || null;
    const want = Number(body.want);
    const max = this.maxSlots();
    let slot = null;
    if (Number.isInteger(want) && want >= 1 && want <= max) slot = want;
    else {
      const before = this.agents.get(agent)?.slot;
      slot = before && !this.slotTaken(before, now, agent) ? before : this.freeSlot(now, agent);
    }
    if (!slot) throw new HttpError(503, `all ${max} slots are taken`);
    // Recorded before the tunnel lookup, so an agent joining at the same moment doesn't get the same slot.
    const a = { id: agent, slot, pool, label, joined: now };
    this.agents.set(agent, a);
    this.sql.exec(
      `INSERT INTO agents (id, slot, kind, label, joined, pool) VALUES (?, ?, '', ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET slot = excluded.slot, label = excluded.label, joined = excluded.joined, pool = excluded.pool`,
      agent, slot, label, now, pool,
    );
    this.holds.set(slot, { agent, at: now }); // holds the slot until its first check-in
    const tunnel = await this.tunnelFor(slot);
    return { machine: slot, tunnelToken: tunnel.token, domain: this.env.DOMAIN };
  }

  async cf(path, init = {}) {
    const res = await fetch(`${this.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4"}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.env.CF_API_TOKEN}`, "content-type": "application/json" },
    });
    const data = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
    if (!data.success) throw new HttpError(502, `Cloudflare API ${path.split("?")[0]}: ${JSON.stringify(data.errors)}`);
    return data;
  }

  // Tunnel runner-<n>: found by name (so tunnels made earlier are reused) or created, and kept with its token.
  tunnelFor(n) {
    if (this.slots.has(n)) return Promise.resolve(this.slots.get(n));
    if (!this.tunnelJobs.has(n)) {
      const job = (async () => {
        const account = this.env.ACCOUNT_ID;
        const name = `runner-${n}`;
        let t = (await this.cf(`/accounts/${account}/cfd_tunnel?name=${name}&is_deleted=false`)).result[0];
        if (!t) {
          const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
          t = (await this.cf(`/accounts/${account}/cfd_tunnel`, {
            method: "POST",
            body: JSON.stringify({ name, config_src: "local", tunnel_secret: secret }),
          })).result;
        }
        const token = (await this.cf(`/accounts/${account}/cfd_tunnel/${t.id}/token`)).result;
        const slot = { n, tunnel: t.id, token };
        this.sql.exec("INSERT OR REPLACE INTO slots (n, tunnel, token, created) VALUES (?, ?, ?, ?)", n, t.id, token, Date.now());
        this.slots.set(n, slot);
        this.scheduleDns();
        return slot;
      })().finally(() => this.tunnelJobs.delete(n));
      this.tunnelJobs.set(n, job);
    }
    return this.tunnelJobs.get(n);
  }

  // Retire a slot nothing runs in any more: delete its tunnel, forget its runs and agents, and drop its DNS names.
  // (A pool that's short of machines takes the lowest free slot, so it may come back as a fresh slot.)
  async retireSlot(n) {
    const now = Date.now();
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "slot must be a machine number");
    if (this.liveRuns(now).some((r) => r.machine === n)) throw new HttpError(409, `machine ${n} is still up; stop it first`);
    const slot = this.slots.get(n);
    if (slot) {
      // Its <project>-n names first: the regular DNS sync only touches records of tunnels it still knows.
      const records = (await this.cf(`/zones/${this.env.ZONE}/dns_records?type=CNAME&content=${slot.tunnel}.cfargotunnel.com&per_page=1000`)).result;
      if (records.length) await this.cf(`/zones/${this.env.ZONE}/dns_records/batch`, { method: "POST", body: JSON.stringify({ deletes: records.map((r) => ({ id: r.id })) }) });
      await this.cf(`/accounts/${this.env.ACCOUNT_ID}/cfd_tunnel/${slot.tunnel}?cascade=true`, { method: "DELETE" });
      this.slots.delete(n);
      this.sql.exec("DELETE FROM slots WHERE n = ?", n);
    }
    for (const [id, a] of this.agents) if (a.slot === n) this.agents.delete(id);
    this.sql.exec("DELETE FROM agents WHERE slot = ?", n);
    for (const r of [...this.runs.values()]) if (r.machine === n) this.runs.delete(r.id);
    this.sql.exec("DELETE FROM runs WHERE machine = ?", n);
    this.starts.delete(n);
    this.sql.exec("DELETE FROM starts WHERE machine = ?", n);
    this.holds.delete(n);
    this.liveMetrics.delete(n);
    for (const [name, placed] of this.placements) if (placed.has(n)) this.dropPlacement(name, n);
    this.scheduleDns();
    return { retired: n, tunnel: slot?.tunnel ?? null };
  }

  // For the shared URLs: project -> slots whose current run is online, should run it, and has it healthy.
  // (A machine keeps reporting a project healthy for a moment after it's told to remove it.)
  healthyRoutes(now) {
    const newest = new Map();
    for (const r of this.liveRuns(now)) {
      if (r.ready && (newest.get(r.machine)?.started ?? -1) < r.started) newest.set(r.machine, r);
    }
    const out = {};
    for (const p of this.projects.values()) {
      if (!p.enabled || !this.version(p.name, p.version)?.port) continue;
      out[p.name] = [...newest.values()].filter((r) => this.runsOn(p.name, r.machine) && r.status[p.name]?.s === "healthy").map((r) => r.machine);
    }
    return out;
  }

  cleanup(now) {
    this.flushMetrics(now);
    if (now - this.lastRollup > MIN) {
      this.lastRollup = now;
      this.rollupMetrics(now);
    }
    if (now - this.lastCleanup < 10 * 60_000) return;
    this.lastCleanup = now;
    this.sql.exec("DELETE FROM metrics_1m WHERE t < ?", now - KEEP_1M_MS);
    this.sql.exec("DELETE FROM metrics_10m WHERE t < ?", now - KEEP_10M_MS);
    for (const r of this.runs.values()) {
      if (now - r.seen > 2 * 3600_000) {
        this.runs.delete(r.id);
        this.sql.exec("DELETE FROM runs WHERE id = ?", r.id);
      }
    }
  }

  // ---- metrics ----

  // The run that speaks for a machine: its newest ready run, or its newest run if none is ready yet.
  // During a handover two runs (two different VMs) report; only one of them is the machine on the charts.
  speaksFor(r, now) {
    const runs = this.liveRuns(now).filter((x) => x.machine === r.machine);
    const pick = (list) => list.sort((a, b) => b.started - a.started)[0];
    return (pick(runs.filter((x) => x.ready)) ?? pick(runs))?.id === r.id;
  }

  takeMetrics(r, metrics, now) {
    if (!isMap(metrics) || r.retire || !this.speaksFor(r, now)) return;
    if (isMap(metrics.live) && isMap(metrics.live.h)) {
      const h = metrics.live.h;
      this.liveMetrics.set(r.machine, { run: r.id, started: r.started, t: Number(metrics.live.t) || now, h, a: isMap(metrics.live.a) ? metrics.live.a : {} });
      const list = this.samples.get(r.machine) ?? this.samples.set(r.machine, []).get(r.machine);
      list.push({ t: now, cpu: Number(h.cpu) || 0, mem: h.memTotal ? (100 * (h.memUsed || 0)) / h.memTotal : 0 });
      while (list.length && now - list[0].t > this.hotMs() * 2) list.shift();
    }
    for (const m of Array.isArray(metrics.minutes) ? metrics.minutes.slice(-60) : []) {
      const t = Number(m?.t);
      if (!Number.isInteger(t) || t % MIN || t > now || now - t > KEEP_1M_MS || !isMap(m.h)) continue;
      const slot = this.pendingMetrics.get(t) ?? {};
      slot[r.machine] = { h: m.h, a: isMap(m.a) ? m.a : {} };
      this.pendingMetrics.set(t, slot);
    }
  }

  // Writes each finished minute as one row; a minute that already has a row (a late summary) is merged into it.
  flushMetrics(now) {
    for (const [t, slot] of this.pendingMetrics) {
      if (now - t < FLUSH_AFTER_MS) continue;
      const old = this.all("SELECT data FROM metrics_1m WHERE t = ?", t)[0];
      const data = old ? { ...JSON.parse(old.data), ...slot } : slot;
      this.sql.exec("INSERT INTO metrics_1m (t, data) VALUES (?, ?) ON CONFLICT (t) DO UPDATE SET data = excluded.data", t, JSON.stringify(data));
      this.pendingMetrics.delete(t);
      // A late minute in an already rolled-up 10-minute bucket: roll that bucket up again.
      const bucket = t - (t % (10 * MIN));
      if (bucket <= Number(this.settings.get("rolled10") ?? 0)) this.rollupBucket(bucket);
    }
  }

  rollupBucket(b) {
    const rows = this.all("SELECT data FROM metrics_1m WHERE t >= ? AND t < ?", b, b + 10 * MIN).map((r) => JSON.parse(r.data));
    if (!rows.length) return;
    this.sql.exec("INSERT INTO metrics_10m (t, data) VALUES (?, ?) ON CONFLICT (t) DO UPDATE SET data = excluded.data", b, JSON.stringify(mergeFleet(rows)));
  }

  // 10-minute rows for every bucket whose minutes are all written.
  rollupMetrics(now) {
    const step = 10 * MIN;
    let last = Number(this.settings.get("rolled10") ?? 0);
    if (!last) last = now - (now % step) - 2 * step;
    for (let b = last + step, n = 0; b + step + FLUSH_AFTER_MS <= now && n < 300; b += step, n++) {
      this.rollupBucket(b);
      last = b;
    }
    if (String(last) !== this.settings.get("rolled10")) this.setSetting("rolled10", last);
  }

  // Columns for charts: t[i], and for each machine its host fields and each app's fields as arrays aligned to t.
  metrics(rangeName) {
    const range = RANGES[rangeName];
    if (!range) throw new HttpError(400, `range is one of ${Object.keys(RANGES).join(", ")}`);
    const [span, step, table] = range;
    const now = Date.now();
    const end = now - (now % step);
    const from = end - span;
    const buckets = new Map();
    for (const row of this.all(`SELECT t, data FROM ${table} WHERE t >= ? ORDER BY t`, from)) {
      const b = row.t - (row.t % step);
      (buckets.get(b) ?? buckets.set(b, []).get(b)).push(JSON.parse(row.data));
    }
    const t = [];
    for (let b = from; b <= end; b += step) t.push(b);
    const machines = {};
    const col = (obj, k) => (obj[k] ??= new Array(t.length).fill(null));
    t.forEach((b, i) => {
      const rows = buckets.get(b);
      if (!rows) return;
      for (const [m, x] of Object.entries(rows.length > 1 ? mergeFleet(rows) : rows[0])) {
        const mm = (machines[m] ??= { h: {}, a: {} });
        for (const [k, v] of Object.entries(x.h ?? {})) col(mm.h, k)[i] = v;
        for (const [app, a] of Object.entries(x.a ?? {})) {
          const aa = (mm.a[app] ??= {});
          for (const [k, v] of Object.entries(a)) col(aa, k)[i] = v;
        }
      }
    });
    const live = {};
    for (const [m, x] of this.liveMetrics) {
      const r = this.runs.get(x.run);
      if (now - x.t > LIVE_MS || !r) continue;
      live[m] = { ...x, ready: Boolean(r.ready), status: r.status };
    }
    return {
      now, range: rangeName, step, expected: this.expectedMachines(),
      projects: [...this.projects.values()].map((p) => this.describe(p)).sort((a, b) => a.name.localeCompare(b.name)),
      t, m: machines, live,
    };
  }

  metricsResponse(rangeName) {
    const now = Date.now();
    const c = this.metricsCache.get(rangeName);
    if (!c || now - c.at > 15_000) this.metricsCache.set(rangeName, { at: now, body: JSON.stringify(this.metrics(rangeName)) });
    return new Response(this.metricsCache.get(rangeName).body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  status() {
    const now = Date.now();
    return {
      now,
      domain: this.env.DOMAIN,
      pools: Object.entries(this.pools()).map(([name, size]) => ({ name, size, live: new Set(this.liveRuns(now).filter((r) => r.pool === name).map((r) => r.machine)).size })),
      expected: this.expectedMachines(),
      dnsError: this.dnsError,
      dnsNotes: this.dnsNotes ?? [],
      rebalance: { on: this.rebalanceOn(), log: this.rebalanceLog.slice(0, 10), hot: [...this.liveMachines(now).keys()].filter((m) => this.isHot(m, now)) },
      // Slots to show: ones with a recent run, plus ones a machine is starting for.
      slots: [...new Set([
        ...[...this.runs.values()].filter((r) => now - r.seen < 3600_000).map((r) => r.machine),
        ...[...this.starts].filter(([, at]) => now - at < START_WAIT_MS).map(([n]) => n),
      ])].sort((a, b) => a - b),
      projects: [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => this.describe(p)),
      runs: [...this.runs.values()]
        .filter((r) => now - r.seen < 3600_000)
        .sort((a, b) => a.machine - b.machine || a.started - b.started)
        .map((r) => ({
          id: r.id,
          machine: r.machine,
          started: r.started,
          seen: r.seen,
          live: this.live(r, now),
          ready: Boolean(r.ready),
          handover: Boolean(r.handover),
          retiring: Boolean(r.retire),
          pool: r.pool ?? null,
          draining: Boolean(r.drain),
          url: r.url ?? null,
          label: r.label,
          projects: r.status,
        })),
    };
  }

  // ---- DNS and routes ----
  // <project>-<n>.DOMAIN -> tunnel runner-<n> for every slot that has a tunnel, and <project>.DOMAIN -> this Worker
  // (a proxied placeholder record plus a Worker route), for every project with a port. Disabled projects keep theirs,
  // so turning one back on is instant. Names already used by records that aren't ours are left alone.

  scheduleDns() {
    this.dnsDue = Date.now() + 2_000;
    this.ctx.storage.setAlarm(this.dnsDue);
  }

  // The alarm keeps DNS in line: hourly, or 2s after a change.
  async alarm() {
    const now = Date.now();
    if (now >= (this.dnsDue ?? 0)) {
      try {
        await this.syncDns();
        this.dnsError = null;
        this.dnsDue = now + 3600_000; // re-check hourly in case something drifted
      } catch (e) {
        this.dnsError = e.message;
        console.log(`DNS sync failed: ${e.message}`);
        this.dnsDue = now + 60_000;
      }
    }
    await this.ctx.storage.setAlarm(this.dnsDue);
  }

  async syncDns() {
    const domain = this.env.DOMAIN;
    const zone = this.env.ZONE;
    const tunnelOf = new Map([...this.slots.values()].map((x) => [x.n, `${x.tunnel}.cfargotunnel.com`]));
    const ours = new Set(tunnelOf.values());
    const want = new Map(); // name -> CNAME target
    const shared = new Set(); // <project>.DOMAIN
    for (const p of this.projects.values()) {
      const port = this.version(p.name, p.version)?.port ?? (p.stable != null ? this.version(p.name, p.stable)?.port : null);
      if (!port) continue;
      shared.add(`${p.name}.${domain}`);
      for (const [n, target] of tunnelOf) want.set(`${p.name}-${n}.${domain}`, target);
    }
    const existing = [];
    for (let page = 1; ; page++) {
      const data = await this.cf(`/zones/${zone}/dns_records?per_page=1000&page=${page}`);
      existing.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    const isShared = (r) => r.type === "AAAA" && r.content === SHARED_DNS && r.comment === "hetp4401/runner";
    const byName = new Map();
    for (const r of existing) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);
    const notes = [];
    const batch = { deletes: [], posts: [], patches: [] };
    for (const r of existing) {
      if ((r.type === "CNAME" && ours.has(r.content) && !want.has(r.name)) || (isShared(r) && !shared.has(r.name))) batch.deletes.push({ id: r.id });
    }
    for (const [name, content] of want) {
      const rs = byName.get(name) ?? [];
      const r = rs.find((x) => x.type === "CNAME");
      if (!rs.length) batch.posts.push({ type: "CNAME", name, content, proxied: true, comment: "hetp4401/runner" });
      else if (r && r.content !== content && ours.has(r.content)) batch.patches.push({ id: r.id, content });
    }
    const servable = new Set(); // shared names this Worker may answer
    for (const name of shared) {
      const rs = byName.get(name) ?? [];
      if (!rs.length) batch.posts.push({ type: "AAAA", name, content: SHARED_DNS, proxied: true, comment: "hetp4401/runner" });
      else if (!rs.every(isShared)) {
        notes.push(`${name} is already used by another DNS record, so it isn't a shared URL`);
        continue;
      }
      servable.add(name);
    }
    if (batch.deletes.length || batch.posts.length || batch.patches.length) {
      await this.cf(`/zones/${zone}/dns_records/batch`, { method: "POST", body: JSON.stringify(batch) });
    }
    // Worker routes for the shared names.
    const script = this.env.SCRIPT_NAME ?? "runner-control";
    const routes = (await this.cf(`/zones/${zone}/workers/routes`)).result;
    const mine = new RegExp(`^[a-z0-9-]+\\.${domain.replace(/\./g, "\\.")}/\\*$`);
    for (const r of routes) {
      const name = r.pattern.slice(0, -2);
      if (r.script === script && mine.test(r.pattern) && !servable.has(name)) {
        await this.cf(`/zones/${zone}/workers/routes/${r.id}`, { method: "DELETE" });
      }
    }
    for (const name of servable) {
      const r = routes.find((x) => x.pattern === `${name}/*`);
      if (!r) await this.cf(`/zones/${zone}/workers/routes`, { method: "POST", body: JSON.stringify({ pattern: `${name}/*`, script }) });
      else if (r.script !== script) notes.push(`${name}/* already routes to Worker ${r.script}`);
    }
    this.dnsNotes = notes;
  }

}

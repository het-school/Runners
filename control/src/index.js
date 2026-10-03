// Control plane for hetp4401/runner.
// Holds the project specs (a docker compose file plus any Dockerfiles and build files) and sends every change to all
// machines. Machines find it, not the other way round: any agent joins at /api/join, gets the lowest free slot n and
// the token for tunnel runner-<n> (created through the Cloudflare API the first time a slot is used), then checks in
// at /api/sync. The agent describes its machine; this never knows what's behind it:
//   pool     the name of a replaceable set it belongs to (the control plane keeps each pool at its size), or none
//            for a standalone host that keeps its slot across restarts
//   starts   whether it can start machines: pool members that can are asked to start missing peers and their own
//            replacements; for the rest, whatever watches the pool asks /api/claim
//   label    a name for it, shown on the pages
//   leaving  on its last check-in, when it's going for good (its replicas are placed elsewhere at once)
// and whatever runs the machine pings POST /api/drain when it's going down soon (a timer, a cron before
// maintenance, a cloud termination notice): the control plane then hands the machine over, one at a time, the same
// way as for a requested roll. Nothing here predicts lifetimes.
// It also keeps DNS in line. The public URLs are this Worker's, one per replica: <project>-<k> passes each request on
// to the machine running replica k (replicas are numbered 1 to N and keep their number when they move, so these URLs
// only change with the replica count). There's no shared URL in front of a project's replicas. The Worker reaches
// machine n at <project>-m<n>, which points at tunnel runner-<n>, and says which replica it wants in a header, since
// a machine may run more than one copy of a project (with more replicas than machines).
//   /            the UI (everything public)  /api/*        API: the fleet password (x-fleet-password) for everything, or
//                                                          the join token (Bearer) for machines: join/sync/claim/drain/roll
//                                            /admin/api/*  the UI's API: anyone can see everything and deploy a new
//                                                          app, which sets that app's password; changing an app needs
//                                                          its password (x-app-password) or the fleet password
//                                                          (x-fleet-password), and fleet changes need the fleet password
//   /admin, /metrics  redirect to the app      /api/metrics  machine and app metrics (no token needed)
import { DurableObject } from "cloudflare:workers";
import YAML from "yaml";
import APP_PAGE from "./app.html";

const POLL_S = 20; // how often agents check in
const PASSWORD_TRIES = 5; // wrong passwords from one address (per app, and for the fleet) before it's refused for PASSWORD_LOCKOUT_MS
const PASSWORD_LOCKOUT_MS = 15 * 60_000;
const APP_PASSWORD_MIN = 6;
const APP_PASSWORD_MAX = 200;
const PBKDF2_ITERATIONS = 10_000; // app passwords are stored as salted PBKDF2-SHA256 (kept light for the CPU limit)
const LIVE_MS = 75_000; // a run counts as up if it checked in this recently
const START_WAIT_MS = 8 * 60_000; // after starting a machine, give it this long to show up before trying again
const HANDOVER_STUCK_MS = 15 * 60_000; // a handover slower than this stops holding up the other machines
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE_PATH = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;
const MAX_FILES = 30;
const MAX_SPEC_BYTES = 256_000;
const STANDALONE_HOLD_MS = 30 * 60_000; // a standalone machine that drops out keeps its slot this long, so a restart gets the same one
const REPLICA_DNS = "100::"; // <project>-<k>.DOMAIN are proxied placeholder records; Worker routes answer them
const NUMBERED = /-m?\d+$/; // <project>-<k> is replica k's URL and <project>-m<n> machine n's, so no project name ends like that
const MAX_REPLICAS = 20; // each replica on a different machine; with fewer machines, it runs on all of them
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
// and rolled up into 10-minute rows for the day view
const MIN = 60_000;
// and into hourly rows for the week and month views, so those read a few hundred rows rather than thousands.
const KEEP_1M_MS = 48 * 3600_000;
const KEEP_10M_MS = 3 * 24 * 3600_000;
const KEEP_1H_MS = 30 * 24 * 3600_000;
const FLUSH_AFTER_MS = 150_000; // a minute is written once its summaries have had time to arrive
const RANGES = { // range -> [span, step, table]
  "1h": [3600_000, MIN, "metrics_1m"],
  "6h": [6 * 3600_000, 2 * MIN, "metrics_1m"],
  "24h": [24 * 3600_000, 10 * MIN, "metrics_10m"],
  "7d": [7 * 24 * 3600_000, 60 * MIN, "metrics_1h"],
  "30d": [30 * 24 * 3600_000, 240 * MIN, "metrics_1h"],
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
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
// Two hex digests compared in constant time.
const sameHex = (a, b) => typeof a === "string" && a.length === b.length && crypto.subtle.timingSafeEqual(fromHex(a), fromHex(b));

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

// Apps deployed without the fleet password get an ordinary container and nothing more: no way out to the machine
// (its files, its processes, its network, Docker itself), which is where the join token and the machine's other
// secrets are. So their compose files may only use what's listed here; anything else needs the fleet password. It's
// a list of what's allowed, so whatever compose adds later is refused until someone has looked at it.
const SAFE_TOP = new Set(["services", "volumes", "networks", "name", "version"]);
const SAFE_SERVICE = new Set(["image", "build", "command", "entrypoint", "environment", "env_file", "ports", "expose",
  "restart", "healthcheck", "depends_on", "working_dir", "user", "labels", "networks", "volumes", "tmpfs", "init",
  "stop_signal", "stop_grace_period", "mem_limit", "mem_reservation", "memswap_limit", "cpus", "cpu_shares", "shm_size",
  "pids_limit", "ulimits", "read_only", "stdin_open", "tty", "hostname", "domainname", "dns", "dns_search", "dns_opt",
  "extra_hosts", "platform", "pull_policy", "logging", "deploy", "network_mode", "cap_drop", "links", "profiles", "scale"]);
const SAFE_BUILD = new Set(["context", "dockerfile", "dockerfile_inline", "args", "target", "labels", "no_cache", "pull",
  "shm_size", "tags", "platforms"]);
const RESERVED_PORTS = new Set([2019, 19080]); // the machine's router and its admin API

// What an untrusted compose file asks for that it may not have (empty if nothing).
function sandboxProblems(doc) {
  const out = [];
  const no = (where, why) => out.push(why ? `${where} (${why})` : where);
  const ext = (k) => k.startsWith("x-");
  // A path on the machine is fine only inside the app's own folder, written plainly: no variables, which compose
  // fills in on the machine (from .env too), so what's checked here is what it uses.
  const inside = (p) => typeof p === "string" && !p.includes("$") && !/^[/~\\]|^[a-z]:/i.test(p) && joinPath(p) !== null;
  for (const k of Object.keys(doc)) if (!SAFE_TOP.has(k) && !ext(k)) no(k);
  for (const [k, v] of Object.entries(isMap(doc.volumes) ? doc.volumes : {})) {
    // driver_opts can bind any folder of the machine, external/name reach volumes that aren't this app's
    if (isMap(v) && Object.keys(v).some((x) => !["labels", "driver"].includes(x) && !ext(x)) || (isMap(v) && v.driver && v.driver !== "local")) {
      no(`volumes.${k}`, "only plain named volumes");
    }
  }
  for (const [k, v] of Object.entries(isMap(doc.networks) ? doc.networks : {})) {
    if (isMap(v) && (Object.keys(v).some((x) => !["labels", "internal", "attachable", "driver", "enable_ipv6"].includes(x) && !ext(x)) || (v.driver && v.driver !== "bridge"))) {
      no(`networks.${k}`, "only plain bridge networks");
    }
  }
  const services = Object.keys(doc.services);
  for (const [name, s] of Object.entries(doc.services)) {
    if (!isMap(s)) continue;
    const at = `services.${name}`;
    for (const k of Object.keys(s)) if (!SAFE_SERVICE.has(k) && !ext(k)) no(`${at}.${k}`);
    if (s.build != null) {
      const b = isMap(s.build) ? s.build : { context: s.build };
      for (const k of Object.keys(b)) if (!SAFE_BUILD.has(k) && !ext(k)) no(`${at}.build.${k}`);
      const context = String(b.context ?? ".");
      const remote = /^(https?|git):\/\//i.test(context) || context.startsWith("git@");
      if (!remote && !inside(context)) no(`${at}.build.context`, "it must be a folder of the app's own files");
      if (b.dockerfile != null && !inside(String(b.dockerfile))) no(`${at}.build.dockerfile`, "it must be one of the app's own files");
    }
    for (const v of [s.volumes ?? []].flat()) {
      const m = typeof v === "string" ? v : isMap(v) ? v : null;
      if (typeof m === "string") {
        const parts = m.split(":");
        if (m.includes("$")) no(`${at}.volumes`, `${m}: no variables`);
        else if (parts.length > 1 && /^[./~\\]|^[a-z]:$/i.test(parts[0]) && !inside(parts[0])) no(`${at}.volumes`, `${parts[0]} is outside the app's folder`);
      } else if (m) {
        const type = m.type ?? "volume";
        if (!["volume", "bind", "tmpfs"].includes(type)) no(`${at}.volumes`, `type ${type}`);
        else if (type === "bind" && !inside(m.source)) no(`${at}.volumes`, `${m.source} is outside the app's folder`);
        else if (type === "volume" && typeof m.source === "string" && m.source.includes("$")) no(`${at}.volumes`, `${m.source}: no variables`);
        if (isMap(m.bind) && Object.keys(m.bind).some((x) => x !== "propagation" && x !== "create_host_path")) no(`${at}.volumes`, "bind options");
      }
    }
    for (const f of [s.env_file ?? []].flat()) {
      const path = isMap(f) ? f.path : f;
      if (!inside(path)) no(`${at}.env_file`, `${path} must be one of the app's own files`);
    }
    if (s.network_mode != null && !["bridge", "none"].includes(s.network_mode) &&
      !(typeof s.network_mode === "string" && s.network_mode.startsWith("service:") && services.includes(s.network_mode.slice(8)))) {
      no(`${at}.network_mode`, `${s.network_mode}`);
    }
    for (const h of [s.extra_hosts ?? []].flat()) if (JSON.stringify(h).includes("host-gateway")) no(`${at}.extra_hosts`, "host-gateway reaches the machine");
    for (const p of [s.ports ?? []].flat()) {
      const host = isMap(p) ? p.published : String(p).split("/")[0].split(":").slice(-2, -1)[0];
      if (String(host ?? "").includes("$") || RESERVED_PORTS.has(Number(host))) no(`${at}.ports`, `${JSON.stringify(p)}: that port is the machine's`);
    }
    if (isMap(s.logging) && s.logging.driver && !["json-file", "local", "none"].includes(s.logging.driver)) no(`${at}.logging.driver`);
    if (isMap(s.deploy)) {
      for (const k of Object.keys(s.deploy)) if (!["resources", "restart_policy", "replicas", "mode"].includes(k)) no(`${at}.deploy.${k}`);
      if (JSON.stringify(s.deploy.resources ?? {}).includes("devices")) no(`${at}.deploy.resources`, "devices");
    }
  }
  return out;
}

// What a compose file takes on its machine that two projects can't share: the host ports it publishes and its
// container names. Placement keeps projects that would clash off the same machine.
function claimsOf(compose) {
  const out = new Set();
  let doc;
  try {
    doc = YAML.parse(compose, { merge: true });
  } catch {
    return [];
  }
  for (const s of Object.values(isMap(doc?.services) ? doc.services : {})) {
    if (!isMap(s)) continue;
    if (typeof s.container_name === "string") out.add(`container name ${s.container_name}`);
    for (const p of [s.ports ?? []].flat()) {
      // "8080:80", "127.0.0.1:8080:80", "8080-8081:80-81", "8080:80/udp" or { published: 8080 }; a container port on
      // its own gets a random host port, so it claims nothing.
      const host = isMap(p) ? p.published : String(p).split("/")[0].split(":").slice(-2, -1)[0];
      if (host == null || host === "") continue;
      const [a, b = a] = String(host).split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 100) continue;
      for (let n = a; n <= b; n++) out.add(`port ${n}`);
    }
  }
  return [...out];
}

// Copy k of a project on a machine runs as compose project <name> for k = 1 and <name>-r<k> for the others: that's
// its key in what the agent is told and reports back.
const copyKey = (name, k) => (k === 1 ? name : `${name}-r${k}`);

// Why a second copy of this compose file couldn't run next to a first one on the same machine (null: it could). Only
// published ports can be moved out of the way; the machine's network itself and fixed container names can't.
function dupProblem(compose) {
  let doc;
  try {
    doc = YAML.parse(compose, { merge: true });
  } catch {
    return "the compose file";
  }
  for (const [name, s] of Object.entries(isMap(doc?.services) ? doc.services : {})) {
    if (!isMap(s)) continue;
    if (s.network_mode === "host") return `services.${name}.network_mode: host`;
    if (s.container_name != null) return `services.${name}.container_name`;
    for (const p of [s.ports ?? []].flat()) {
      if (JSON.stringify(p).includes("$")) return `services.${name}.ports: variables`;
      if (!isMap(p) && !/^(?:(.*):)?(\d+(?:-\d+)?):(\d+(?:-\d+)?)(\/\w+)?$/.test(String(p)) && !/^\d+(?:-\d+)?(\/\w+)?$/.test(String(p))) return `services.${name}.ports: ${JSON.stringify(p)}`;
    }
  }
  return null;
}

// "8000-8003" -> [8000, 8001, 8002, 8003]; null if it isn't ports.
function portRange(x) {
  if (x == null || x === "") return null;
  const [a, b = a] = String(x).split("-").map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 100) return null;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// The compose file with its published host ports moved as `ports` says ({ "8080": 30412 }), for a copy that shares
// its machine with another copy of the same project. Comments and layout go; the machine only runs it.
function remapCompose(compose, ports) {
  const doc = YAML.parse(compose, { merge: true });
  const at = (i, list) => list[Math.min(i, list.length - 1)];
  for (const s of Object.values(isMap(doc?.services) ? doc.services : {})) {
    if (!isMap(s) || s.ports == null) continue;
    s.ports = [s.ports].flat().flatMap((p) => {
      if (isMap(p)) {
        const pub = portRange(p.published);
        if (!pub) return [p];
        const tgt = portRange(p.target) ?? pub;
        return pub.map((h, i) => ({ ...p, published: String(ports[h] ?? h), target: at(i, tgt) }));
      }
      const m = String(p).match(/^(?:(.*):)?(\d+(?:-\d+)?):(\d+(?:-\d+)?)(\/\w+)?$/);
      if (!m) return [p]; // "80" alone: a random host port, nothing to move
      const [, ip, host, target, proto = ""] = m;
      const hs = portRange(host), ts = portRange(target) ?? hs;
      return hs.map((h, i) => `${ip ? `${ip}:` : ""}${ports[h] ?? h}:${at(i, ts)}${proto}`);
    });
  }
  return YAML.stringify(doc);
}

// The compose file made below for a Dockerfile on its own, as the editor sends it back. It's made afresh on every
// deploy from the port and replica count given now, so a changed port can't disagree with it.
const GENERATED = /^(?:x-runner:\n(?:  port: \d+\n)?(?:  replicas: \d+\n)?)?services:\n  app:\n    build: \.\n(?:    ports: \["\d+:\d+"\]\n)?    restart: unless-stopped\n?$/;

// Turns what was submitted into a spec the machines can run: { compose, port, files }.
// Accepts a compose file, a Dockerfile, extra build files, or a mix; a Dockerfile on its own becomes a
// one-service compose file. Rejects anything that would only fail later on a machine, and, unless the deploy comes
// with the fleet password (trusted), anything that would reach outside the app's container (sandboxProblems).
function buildSpec(body, { trusted = false } = {}) {
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
    const n = Number(x);
    if (!(Number.isInteger(n) && n >= 1 && n <= MAX_REPLICAS)) throw new HttpError(400, `${where} must be a whole number from 1 to ${MAX_REPLICAS}`);
    return n;
  };
  replicas = parseReplicas(replicas, "replicas");
  if (files.Dockerfile && GENERATED.test(compose)) {
    const old = YAML.parse(compose)["x-runner"] ?? {};
    port ??= old.port ?? null;
    replicas ??= parseReplicas(old.replicas, "x-runner.replicas");
    compose = "";
  }
  if (!compose.trim()) {
    if (!files.Dockerfile) throw new HttpError(400, "send a compose file, a Dockerfile, or both");
    // A Dockerfile on its own: build it and publish the port (the app should listen on it inside the container).
    compose = [
      ...(port || replicas !== null ? ["x-runner:"] : []),
      ...(port ? [`  port: ${port}`] : []),
      ...(replicas !== null ? [`  replicas: ${replicas}`] : []),
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
  const declared = doc["x-runner"]?.port ?? null;
  if (declared !== null && !(Number.isInteger(declared) && declared > 0 && declared < 65536)) {
    throw new HttpError(400, "x-runner.port must be a whole number from 1 to 65535");
  }
  if (port !== null && declared !== null && declared !== port) {
    throw new HttpError(400, `the port given (${port}) isn't the compose file's x-runner.port (${declared}); change one of them`);
  }
  port ??= declared;
  replicas ??= parseReplicas(doc["x-runner"]?.replicas, "x-runner.replicas") ?? 1;
  if (!trusted) {
    // Checked as compose reads it: with YAML merge keys (<<) applied.
    const merged = YAML.parse(compose, { merge: true });
    const problems = isMap(merged) && isMap(merged.services) ? sandboxProblems(merged) : ["the compose file"];
    if (problems.length) {
      throw new HttpError(400, `without the fleet password, an app gets an ordinary container only, so its compose file can't use: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? `; and ${problems.length - 6} more` : ""}`);
    }
  }
  // Every service that builds from a local folder needs its Dockerfile among the files.
  for (const [service, def] of Object.entries(doc.services)) {
    if (!isMap(def) || def.build == null) continue;
    const build = isMap(def.build) ? def.build : { context: def.build };
    if (build.dockerfile_inline) continue;
    const context = String(build.context ?? ".");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith("git@")) continue; // a git repo or URL
    const dockerfile = joinPath(context, String(build.dockerfile ?? "Dockerfile"));
    if (dockerfile === null) throw new HttpError(400, `service ${service} builds from outside the app's folder`);
    if (!(dockerfile in files)) {
      throw new HttpError(400, `service ${service} builds from ${dockerfile}, but no file with that path was sent`);
    }
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return { compose, port, replicas, files: sorted };
}

// ---- public URLs: <project>-<k>.DOMAIN goes to the machine running replica k ----

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

async function proxy(request, env, label) {
  const routes = await healthyRoutes(env);
  // A replica's machine: one, or two while the replica moves (the new copy first, then the old one).
  const slots = routes.replicas[label];
  if (!slots) return new Response(`nothing is served at ${label}\n`, { status: 404 });
  if (!slots.length) {
    return new Response(`${label} isn't healthy on any machine right now\n`, { status: 503, headers: { "retry-after": "10" } });
  }
  const project = label.replace(/-\d+$/, "");
  // Requests without a body can try the other copy when one doesn't answer.
  const retry = request.method === "GET" || request.method === "HEAD";
  const host = new URL(request.url).hostname;
  let res = null;
  for (const n of slots.slice(0, retry ? 3 : 1)) {
    const url = new URL(request.url);
    url.hostname = `${project}-m${n}.${env.DOMAIN}`;
    const req = new Request(url, request);
    req.headers.set("x-forwarded-host", host);
    req.headers.set("x-runner-replica", label.slice(label.lastIndexOf("-") + 1)); // the machine may run more than one copy
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
    // Keep visitors on the replica's URL when the app redirects to the machine's own hostname.
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
# Optional: LABEL=<name> names it on the status pages (default: its hostname).
# The agent runs in the container runner-agent, takes a free slot n, and runs the replicas placed on this
# machine. It fetches the latest agent code each time it starts.
# Remove the machine:  docker rm -f runner-agent tunnel router
set -eu
: "\${JOIN_TOKEN:?set JOIN_TOKEN; the fleet's owner gets it with: runnerctl join-token}"
DATA=\${RUNNER_DATA:-/var/lib/runner}
command -v docker >/dev/null 2>&1 || { echo "Install Docker first: https://docs.docker.com/engine/install/" >&2; exit 1; }
mkdir -p "$DATA"
docker rm -f runner-agent >/dev/null 2>&1 || true
docker run -d --name runner-agent --restart unless-stopped --stop-timeout 180 --network host --hostname "$(hostname)" \\
  -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA:$DATA" \\
  -e CONTROL_URL=${origin} -e JOIN_TOKEN="$JOIN_TOKEN" -e RUNNER_DATA="$DATA" \\
  -e LABEL="\${LABEL:-$(hostname)}" \\
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

const MAX_BODY = 1_000_000; // bytes; a spec is at most MAX_SPEC_BYTES, plus JSON quoting

export default {
  async fetch(request, env) {
    const host = new URL(request.url).hostname;
    const suffix = `.${env.DOMAIN}`;
    if (host !== env.CONTROL_HOST && host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".")) {
      return proxy(request, env, host.slice(0, -suffix.length));
    }
    // The object gets the whole body up front: a body still streaming in after the object has replied (a refused
    // change, say) fails the stream, and that resets the object.
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "the request is too big" }, 413);
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY) return json({ error: "the request is too big" }, 413);
    }
    return env.CONTROL.get(env.CONTROL.idFromName("main")).fetch(new Request(request, { body }));
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
      `CREATE TABLE IF NOT EXISTS copies (name TEXT NOT NULL, machine INTEGER NOT NULL, replica INTEGER NOT NULL,
         since INTEGER NOT NULL, reason TEXT NOT NULL, leaving TEXT, ports TEXT, PRIMARY KEY (name, machine, replica))`,
      `CREATE TABLE IF NOT EXISTS slots (n INTEGER PRIMARY KEY, tunnel TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, slot INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT, joined INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS metrics_1m (t INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS metrics_10m (t INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS metrics_1h (t INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS app_passwords (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, updated INTEGER NOT NULL)`,
    ]) {
      this.sql.exec(query);
    }
    // Columns added after the first release.
    const columns = (table) => new Set(this.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (!columns("projects").has("enabled")) this.sql.exec("ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    if (!columns("versions").has("files")) this.sql.exec("ALTER TABLE versions ADD COLUMN files TEXT");
    if (!columns("versions").has("replicas")) this.sql.exec("ALTER TABLE versions ADD COLUMN replicas INTEGER");
    const runColumns = columns("runs");
    if (!runColumns.has("agent")) this.sql.exec("ALTER TABLE runs ADD COLUMN agent TEXT");
    if (!runColumns.has("kind")) this.sql.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT ''"); // no longer used
    if (!runColumns.has("label")) this.sql.exec("ALTER TABLE runs ADD COLUMN label TEXT");
    for (const col of ["pool TEXT", "drain INTEGER"]) if (!runColumns.has(col.split(" ")[0])) this.sql.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
    if (!columns("agents").has("pool")) this.sql.exec("ALTER TABLE agents ADD COLUMN pool TEXT");
    // Working state lives in memory (the object is single-threaded); SQLite keeps it across restarts,
    // which happen whenever Cloudflare lets the object sleep.
    this.projects = new Map(this.all("SELECT * FROM projects").map((p) => [p.name, p]));
    this.runs = new Map(this.all("SELECT * FROM runs").map((r) => [r.id, { ...r, status: JSON.parse(r.status), savedSeen: r.seen }]));
    this.starts = new Map(this.all("SELECT machine, at FROM starts").map((s) => [s.machine, s.at]));
    this.startPools = new Map();
    this.settings = new Map(this.all("SELECT key, value FROM settings").map((s) => [s.key, s.value]));
    this.poolAsks = new Map(Object.entries(JSON.parse(this.settings.get("pool_asks") ?? "{}"))); // pool sizes as their joiners gave them
    this.versions = new Map(); // "name@version" -> { compose, port, replicas, files, claims }
    this.blocked = new Map(); // project -> why a replica of it has no machine (a clash with what's placed everywhere)
    this.copies = new Map(); // project -> [{ machine, replica, since, reason, leaving, ports }], one per copy
    // Copies used to be kept one per machine (table placements); carry them over the first time.
    if (!this.all("SELECT 1 FROM copies LIMIT 1").length && this.all("SELECT name FROM sqlite_master WHERE name = 'placements'").length) {
      const used = new Map();
      for (const x of this.all("SELECT * FROM placements ORDER BY since")) {
        const taken = used.get(x.name) ?? used.set(x.name, new Set()).get(x.name);
        let k = x.replica;
        if (k == null) for (k = 1; taken.has(k); k++);
        taken.add(k);
        this.sql.exec("INSERT OR REPLACE INTO copies (name, machine, replica, since, reason, leaving, ports) VALUES (?, ?, ?, ?, ?, ?, NULL)",
          x.name, x.machine, k, x.since, x.reason, x.leaving);
      }
    }
    for (const x of this.all("SELECT * FROM copies ORDER BY since")) {
      (this.copies.get(x.name) ?? this.copies.set(x.name, []).get(x.name))
        .push({ machine: x.machine, replica: x.replica, since: x.since, reason: x.reason, leaving: x.leaving ? JSON.parse(x.leaving) : null, ports: x.ports ? JSON.parse(x.ports) : null });
    }
    this.remapped = new Map(); // "name@v|ports" -> compose text with moved ports
    this.bootAt = Date.now();
    this.samples = new Map(); // machine -> [{ t, cpu, mem }] from the last few minutes, for spotting hot machines
    this.lastRebalance = 0;
    this.failures = new Map(); // "address|fleet" or "address|app:<name>" -> { n, at }: wrong passwords
    this.appPasswords = new Map(this.all("SELECT name, salt, hash FROM app_passwords").map((x) => [x.name, x])); // never sent out
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
    // A deploy of this Worker resets its routes to the ones in wrangler.toml, so put the replica URLs' back.
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

  // A pool's size as its joiners give it (members re-send it with every check-in; kept across restarts, so a pool
  // whose members can't start machines isn't taken for oversized until its watcher asks again).
  askPoolSize(pool, size) {
    const n = Number(size);
    if (!pool || size == null || size === "" || !Number.isInteger(n) || n < 0 || n > this.maxSlots() || this.poolAsks.get(pool) === n) return;
    this.poolAsks.set(pool, n);
    this.setSetting("pool_asks", JSON.stringify(Object.fromEntries(this.poolAsks)));
  }

  // Just after a (re)start, runs loaded from storage haven't checked in yet to say which pool they're in. Until they
  // have (or 150 s have passed), a pool looks smaller than it is, so nothing is started or retired on that account.
  settling(now) {
    return now - this.bootAt < 2 * LIVE_MS && this.liveRuns(now).some((x) => now - x.seen > now - this.bootAt);
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
      if (!row) return undefined; // not cached: a version asked for before it's deployed mustn't stay missing once it is
      const claims = new Set(claimsOf(row.compose));
      if (row.port) claims.add(`port ${row.port}`);
      this.versions.set(key, { compose: row.compose, port: row.port, replicas: row.replicas ?? 1, files: JSON.parse(row.files ?? "{}"), claims: [...claims], nodup: dupProblem(row.compose) });
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
      `INSERT INTO runs (id, machine, started, status, ready, handover, retire, seen, agent, kind, label, pool, drain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, ready = excluded.ready, handover = excluded.handover,
         retire = excluded.retire, seen = excluded.seen, label = excluded.label, pool = excluded.pool, drain = excluded.drain`,
      r.id, r.machine, r.started, JSON.stringify(r.status), r.ready, r.handover, r.retire, r.seen, r.agent, "", r.label, r.pool ?? null, r.drain ?? 0,
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
      if (request.method === "GET" && path === "/") return html(APP_PAGE);
      // The old pages are views of the app now; the app turns their #fragments into its own routes.
      if (request.method === "GET" && (path === "/admin" || path === "/metrics")) {
        return new Response(null, { status: 302, headers: { location: `/?from=${path.slice(1)}` } });
      }
      if (request.method === "GET" && path === "/install.sh") return new Response(installScript(url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (request.method === "GET" && path === "/internal/routes") return json(this.healthyRoutes(Date.now()));
      if (path.startsWith("/admin/api/")) {
        // The UI: anyone can see everything and deploy a new app; changing an app needs its password or the fleet
        // password, and fleet changes need the fleet password. Changes sent from other sites are refused. No machine
        // powers here (joining, checking in): those hand out tunnel tokens.
        const origin = request.headers.get("origin");
        if (request.method !== "GET" && origin && origin !== url.origin) throw new HttpError(403, "cross-site request refused");
        const route = path.slice("/admin/api".length);
        const ip = request.headers.get("cf-connecting-ip") ?? "";
        // Passwords are only looked at where they count (fleet changes, changes to apps), so an address refused for
        // wrong guesses can still see everything.
        const fleet = /^\/(unlock|settings|roll|join-token|machines\/\d+\/evict|slots\/\d+)$/.test(route);
        const appChange = request.method !== "GET" && route.startsWith("/projects/");
        const password = request.headers.get("x-fleet-password");
        const admin = (fleet || appChange) && password != null && await this.checkPassword(password, ip);
        if (request.method === "POST" && route === "/unlock") {
          if (!admin) throw new HttpError(401, "wrong password");
          return json({ ok: true });
        }
        return await this.api(request, url, route, {
          admin, deploy: true, node: false, ip, fleetWrong: password != null && !admin, appPassword: request.headers.get("x-app-password"),
        });
      }
      if (path.startsWith("/api/")) {
        // Scripts send the fleet password, as the UI does; machines send the join token.
        const password = request.headers.get("x-fleet-password");
        const admin = password != null && await this.checkPassword(password, request.headers.get("cf-connecting-ip") ?? "");
        const node = admin || (Boolean(this.env.JOIN_TOKEN) && request.headers.get("authorization") === `Bearer ${this.env.JOIN_TOKEN}`);
        return await this.api(request, url, path.slice("/api".length), { admin, deploy: admin, node });
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      return json({ error: e.message }, e.status ?? 500);
    }
  }

  // Wrong passwords are counted per address and per thing guessed at (key "address|fleet" or "address|app:<name>"), so
  // getting one app's password right doesn't reset the count for another app or the fleet. Too many, and that address
  // is refused for a while.
  refuseIfLocked(key, now) {
    const f = this.failures.get(key);
    if (f && f.n >= PASSWORD_TRIES && now - f.at < PASSWORD_LOCKOUT_MS) {
      throw new HttpError(429, `too many wrong passwords; try again in ${Math.ceil((PASSWORD_LOCKOUT_MS - (now - f.at)) / 60_000)} min`);
    }
  }

  noteTry(key, ok, now) {
    const f = this.failures.get(key);
    if (ok) return void this.failures.delete(key);
    this.failures.set(key, { n: (f && now - f.at < PASSWORD_LOCKOUT_MS ? f.n : 0) + 1, at: now });
    if (this.failures.size > 10_000) for (const [k, x] of this.failures) if (now - x.at >= PASSWORD_LOCKOUT_MS) this.failures.delete(k);
  }

  // The fleet password (the secret FLEET_PASSWORD), compared in constant time.
  async checkPassword(given, ip) {
    const expected = this.env.FLEET_PASSWORD;
    if (!expected) return false;
    const key = `${ip}|fleet`;
    this.refuseIfLocked(key, Date.now());
    const digest = async (x) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(x));
    const ok = crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
    this.noteTry(key, ok, Date.now());
    return ok;
  }

  // App passwords are kept as salted PBKDF2-SHA256 (hex), never the password itself.
  async passwordHash(password, salt) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
    return toHex(new Uint8Array(bits));
  }

  async newAppSecret(password) {
    if (typeof password !== "string" || password.length < APP_PASSWORD_MIN || password.length > APP_PASSWORD_MAX) {
      throw new HttpError(400, `give the app a password ("password", ${APP_PASSWORD_MIN} to ${APP_PASSWORD_MAX} characters): changing it later needs it`);
    }
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, hash: await this.passwordHash(password, salt) };
  }

  saveAppPassword(name, secret) {
    this.appPasswords.set(name, { name, ...secret });
    this.sql.exec(
      `INSERT INTO app_passwords (name, salt, hash, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated = excluded.updated`,
      name, secret.salt, secret.hash, Date.now(),
    );
  }

  // admin: fleet changes (pools, rebalancing, restarts, evictions, slots, the join token), and any app;
  // deploy: new apps, and changes to an app given its password (appPassword); node: machines.
  async api(request, url, route, { admin, deploy, node, ip = "", fleetWrong = false, appPassword = null }) {
    const { method } = request;
    const body = () => request.json().catch(() => {
      throw new HttpError(400, "the body must be JSON");
    });
    const need = (ok, what = "the fleet password") => {
      if (!ok) throw new HttpError(401, `this needs ${what}`);
    };
    if (method === "GET" && route === "/status") return json(this.status());
    if (method === "GET" && route === "/metrics") return this.metricsResponse(url.searchParams.get("range") ?? "1h");
    if (method === "POST" && route === "/join") return need(node, "the join token"), json(await this.join(await body()));
    if (method === "POST" && route === "/sync") return need(node, "the join token"), json(this.sync(await body()));
    if (method === "POST" && route === "/claim") {
      need(node, "the join token");
      const pool = url.searchParams.get("pool");
      this.askPoolSize(pool, url.searchParams.get("size"));
      return json({ start: this.claimStarts(pool, "claim", Date.now()) });
    }
    if (method === "POST" && route === "/drain") return need(node, "the join token"), json(this.drain(await body()));
    if (method === "POST" && route === "/roll") return need(admin || node, "the fleet password or the join token"), json(this.roll(url.searchParams.get("machine")));
    if (method === "GET" && route === "/join-token") return need(admin), json({ token: this.env.JOIN_TOKEN });
    if (method === "PUT" && route === "/settings") return need(admin), json(this.putSettings(await body()));
    const ev = route.match(/^\/machines\/(\d+)\/evict$/);
    if (ev && method === "POST") return need(admin), json(this.evict(Number(ev[1])));
    const sl = route.match(/^\/slots\/(\d+)$/);
    if (sl && method === "DELETE") return need(admin), json(await this.retireSlot(Number(sl[1])));
    // Apps: anyone can look. Deploying a new one sets its password ("password" in the body; optional with the fleet
    // password); after that, changing it needs that password (x-app-password) or the fleet password. An app with no
    // password (from before app passwords, or deployed with the fleet password and none) needs the fleet password.
    const m = route.match(/^\/projects\/([^/]+)(?:\/(enable|disable|move|unlock|password))?$/);
    if (m) {
      const [, name, action] = m;
      if (!action && method === "GET") return json(this.getProject(name, url.searchParams.get("version")));
      need(deploy);
      const input = method === "PUT" ? await body() : null;
      const key = `${ip}|app:${name}`;
      // The hashing comes first, so the checks and the change below run with no await between them and no other
      // request can slip in (deploying the same new name, say).
      const stored = this.appPasswords.get(name);
      let given = null;
      if (!admin && appPassword != null && stored) {
        this.refuseIfLocked(key, Date.now());
        given = { salt: stored.salt, hash: await this.passwordHash(appPassword, stored.salt) };
      }
      const wasNew = !action && method === "PUT" && !this.projects.has(name);
      const secret = action === "password" || (wasNew && (input?.password != null || !admin)) ? await this.newAppSecret(input?.password) : null;
      // No awaits from here on.
      const creating = !action && method === "PUT" && !this.projects.has(name);
      if (creating && !admin && !secret) throw new HttpError(409, `${name} was just deleted; try again`);
      if (!creating && !admin) {
        this.project(name); // 404 if there's no such app
        const current = this.appPasswords.get(name);
        if (!current) throw new HttpError(401, fleetWrong ? "wrong fleet password" : `${name} has no app password, so changing it needs the fleet password`);
        if (appPassword == null) throw new HttpError(401, fleetWrong ? "wrong fleet password" : `changing ${name} needs its password or the fleet password`);
        const now = Date.now();
        this.refuseIfLocked(key, now);
        const ok = given?.salt === current.salt && sameHex(given.hash, current.hash);
        this.noteTry(key, ok, now);
        if (!ok) throw new HttpError(401, `wrong password for ${name}`);
      }
      if (action === "unlock" && method === "POST") return json({ ok: true });
      if (action === "password" && method === "PUT") {
        this.project(name);
        this.saveAppPassword(name, secret);
        return json({ ok: true });
      }
      if (action === "move" && method === "POST") return json(this.move(name, Number(url.searchParams.get("from")), url.searchParams.get("to"), url.searchParams.get("replica")));
      if ((action === "enable" || action === "disable") && method === "POST") return json(this.setEnabled(name, action === "enable"));
      if (!action && method === "PUT") {
        const out = this.putProject(name, input, { trusted: admin });
        if (creating && secret) {
          this.saveAppPassword(name, secret);
          out.hasPassword = true;
        }
        return json(out);
      }
      if (!action && method === "DELETE") return json(this.deleteProject(name));
    }
    throw new HttpError(404, "not found");
  }


  // ---- projects ----

  describe(p) {
    const latest = this.version(p.name, p.version);
    const placed = this.copiesOf(p.name).map((x) => ({ machine: x.machine, replica: x.replica, since: x.since, reason: x.reason, leaving: x.leaving, moved: Boolean(x.ports) }))
      .sort((a, b) => a.replica - b.replica || Boolean(a.leaving) - Boolean(b.leaving));
    const staying = placed.filter((x) => !x.leaving).length;
    return {
      name: p.name,
      version: p.version,
      stable: p.stable,
      port: latest?.port ?? null,
      replicas: latest?.replicas ?? 1,
      placed, // each replica's machine, by replica number; a copy being moved away (leaving) comes after its new copy
      staying,
      blocked: this.blocked.get(p.name) ?? null, // why a replica has no machine, when it's a clash rather than a shortage
      files: Object.keys(latest?.files ?? {}),
      enabled: Boolean(p.enabled),
      hasPassword: this.appPasswords.has(p.name), // false: only the fleet password can change it
      state: !p.enabled ? "disabled" : p.halted ? "halted" : p.stable === p.version ? "live" : "deploying",
      halted: p.halted,
      updated: p.updated,
    };
  }

  project(name) {
    const p = this.projects.get(name);
    if (!p) throw new HttpError(404, `no app called ${name}`);
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
      replicas: spec.replicas,
      versions: this.all("SELECT version, port, replicas, created FROM versions WHERE name = ? ORDER BY version", name)
        .map((v) => ({ ...v, replicas: v.replicas ?? 1 })),
    };
  }

  // A new spec becomes a new version, which goes to every machine at once.
  putProject(name, body, { trusted = false } = {}) {
    if (!NAME.test(name)) throw new HttpError(400, "app names are lowercase letters, digits and dashes");
    if (!this.projects.has(name) && NUMBERED.test(name)) {
      throw new HttpError(400, "an app name can't end in -<number> or -m<number>: those are the URLs of its replicas and machines");
    }
    const p = this.projects.get(name);
    const latest = p && this.version(name, p.version);
    // Only a replica count or port: the latest version's files are kept as they are, so a page that was open for a
    // while can't put back files someone else has changed since.
    if (latest && isMap(body) && body.compose == null && body.dockerfile == null && body.files == null) {
      body = { ...body, compose: latest.compose, files: latest.files, port: body.port === undefined ? latest.port : body.port,
        replicas: body.replicas === undefined ? latest.replicas : body.replicas };
    }
    const spec = buildSpec(body, { trusted });
    const t = Date.now();
    const machines = this.expectedMachines();
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
    this.sql.exec("DELETE FROM copies WHERE name = ?", name);
    this.sql.exec("DELETE FROM app_passwords WHERE name = ?", name);
    this.copies.delete(name);
    this.blocked.delete(name);
    this.appPasswords.delete(name);
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

  // What machine n should run: every copy placed on it, at its project's latest version (or the last good one if the
  // latest is halted), keyed by copy: <name> for replica 1, <name>-r<k> for the others. Disabled projects run nowhere.
  desiredFor(machine) {
    const out = {};
    for (const p of this.projects.values()) {
      if (!p.enabled) continue;
      const v = p.halted ? p.stable : p.version;
      if (v == null) continue;
      const spec = this.version(p.name, v);
      for (const x of this.copiesOn(p.name, machine)) {
        out[copyKey(p.name, x.replica)] = { v, ...this.composeFor(p.name, v, spec, x), files: spec.files, app: p.name, replica: x.replica };
      }
    }
    return out;
  }

  // What a copy runs: its spec as it is, or, for a copy whose published ports were moved (it shares its machine with
  // another copy of the same project), the compose file with those ports and the port the router dials along with them.
  composeFor(name, v, spec, x) {
    if (!x.ports) return { compose: spec.compose, port: spec.port };
    const key = `${name}@${v}|${JSON.stringify(x.ports)}`;
    if (!this.remapped.has(key)) this.remapped.set(key, remapCompose(spec.compose, x.ports));
    return { compose: this.remapped.get(key), port: x.ports[spec.port] ?? spec.port };
  }

  runsOn(name, machine) {
    return this.copiesOn(name, machine).length > 0;
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
  // A project with N replicas has N copies, numbered 1 to N. A new copy goes to the machine with the most room: the
  // least CPU and memory in use (from its latest metrics) and the fewest copies already placed on it, machines without
  // a copy of the same project first; so with more replicas than machines, some machines run two or more. A copy
  // stays where it is until its machine is gone; then it moves to the best machine left, keeping its number (and so
  // its URL, <project>-<k>); lowering N removes the highest numbers. A second copy on a machine gets its published
  // host ports moved out of the first one's way (ports: { "8080": 30412 }).

  copiesOf(name) {
    return this.copies.get(name) ?? [];
  }

  copiesOn(name, machine) {
    return this.copiesOf(name).filter((x) => x.machine === machine);
  }

  saveCopy(name, x) {
    const list = this.copies.get(name) ?? this.copies.set(name, []).get(name);
    const i = list.findIndex((y) => y.machine === x.machine && y.replica === x.replica);
    if (i >= 0) list[i] = x;
    else list.push(x);
    this.sql.exec("INSERT OR REPLACE INTO copies (name, machine, replica, since, reason, leaving, ports) VALUES (?, ?, ?, ?, ?, ?, ?)",
      name, x.machine, x.replica, x.since, x.reason, x.leaving ? JSON.stringify(x.leaving) : null, x.ports ? JSON.stringify(x.ports) : null);
  }

  dropCopy(name, machine, replica) {
    const list = this.copies.get(name);
    if (list) {
      const i = list.findIndex((y) => y.machine === machine && y.replica === replica);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.copies.delete(name);
    }
    this.sql.exec("DELETE FROM copies WHERE name = ? AND machine = ? AND replica = ?", name, machine, replica);
  }

  // What a copy takes on its machine: its project's claims, with the ports that were moved for it.
  copyClaims(name, x) {
    const p = this.projects.get(name);
    const spec = p && this.version(name, p.version);
    return (spec?.claims ?? []).map((c) => {
      const m = c.match(/^port (\d+)$/);
      return m && x.ports?.[m[1]] ? `port ${x.ports[m[1]]}` : c;
    });
  }

  // How busy a machine is, for choosing between them; lower is better. Without metrics (an agent that's just
  // started) it counts as half busy, so a machine that's measured and quiet wins.
  load(machine, placedCount, now) {
    const m = this.liveMetrics.get(machine);
    const fresh = m && now - m.t < 3 * LIVE_MS;
    const cpu = fresh ? m.h.cpu : 50;
    const mem = fresh && m.h.memTotal ? (100 * m.h.memUsed) / m.h.memTotal : 50;
    return { score: cpu + mem + 30 * placedCount, reason: fresh ? `cpu ${Math.round(cpu)}%, memory ${Math.round(mem)}%, ${placedCount} other ${placedCount === 1 ? "copy" : "copies"} placed` : "no metrics yet" };
  }

  place(now) {
    const up = this.liveMachines(now); // machine -> its newest live run
    let changed = false;
    // After a (re)start the first machine to check in would get every replica, because it's the only one with
    // metrics; wait until every machine that's up has reported some (or 3 minutes).
    const measured = (machine) => now - (this.liveMetrics.get(machine)?.t ?? 0) < 3 * LIVE_MS;
    const arrived = now - this.bootAt > ARRIVAL_MS || (up.size >= this.expectedMachines() && [...up.keys()].every(measured));
    const counts = new Map(); // machine -> copies placed on it
    for (const [name, list] of this.copies) {
      // Projects that are gone or disabled need no copies; neither do machines that have gone, nor replicas
      // numbered above the count (it was lowered), along with any copy of theirs being moved.
      const p = this.projects.get(name);
      const replicas = p ? this.version(name, p.version)?.replicas ?? 1 : null;
      for (const x of [...list]) {
        // A copy being moved away goes once its replacement is healthy, or after a while regardless.
        const moved = x.leaving && (up.get(x.leaving.to)?.status[copyKey(name, x.replica)]?.s === "healthy" || now - x.leaving.at > MOVE_TIMEOUT_MS);
        if (!p || !p.enabled || x.replica > replicas || !up.has(x.machine) || moved) {
          this.dropCopy(name, x.machine, x.replica);
          changed = true;
        } else if (!x.leaving) counts.set(x.machine, (counts.get(x.machine) ?? 0) + 1);
      }
    }
    for (const p of [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!p.enabled) continue;
      const spec = this.version(p.name, p.version);
      const want = spec?.replicas ?? 1;
      // Each number from 1 to the count needs a copy that's staying: a move's new copy counts, its old one doesn't.
      const have = new Set(this.copiesOf(p.name).filter((x) => !x.leaving).map((x) => x.replica));
      this.blocked.delete(p.name);
      for (let k = 1; k <= want && arrived; k++) {
        if (have.has(k)) continue;
        const best = this.bestMachine(p.name, up, counts, now);
        if (!best) {
          if (up.size) this.blocked.set(p.name, this.whyBlocked(p.name, spec, up));
          break;
        }
        this.saveCopy(p.name, this.newCopy(p.name, spec, k, best, now));
        counts.set(best.machine, (counts.get(best.machine) ?? 0) + 1);
        changed = true;
      }
    }
    return changed;
  }

  // A copy for machine `best` (from bestMachine), with its ports moved when the project is already there.
  newCopy(name, spec, k, best, now, reason = best.reason) {
    const x = { machine: best.machine, replica: k, since: now, reason, leaving: null, ports: null };
    if (best.doubling) {
      x.ports = this.movedPorts(name, spec, best.machine, k);
      x.reason = `copy ${best.doubling + 1} on this machine, every machine having one; ${reason}`;
    }
    return x;
  }

  // Why no machine could take a copy, for the project's page.
  whyBlocked(name, spec, up) {
    const empty = [...up.keys()].filter((m) => !this.copiesOn(name, m).length);
    if (empty.length) {
      const clash = empty.map((m) => this.clash(name, m)).find(Boolean);
      return clash ? `every other machine already has an app using ${clash.what} (${clash.other})` : "no machine can take it";
    }
    return `every machine already runs it, and it can't run twice on one machine (${spec?.nodup ?? "its compose file"})`;
  }

  // Host ports for an extra copy of a project on a machine: the project's published ports, each moved to one that
  // nothing on the machine uses. Fixed once chosen, so the copy's containers aren't recreated for a port change.
  movedPorts(name, spec, machine, k) {
    const taken = new Set(RESERVED_PORTS);
    for (const [other, list] of this.copies) {
      for (const x of list) {
        if (x.machine !== machine) continue;
        for (const c of this.copyClaims(other, x)) {
          const m = c.match(/^port (\d+)$/);
          if (m) taken.add(Number(m[1]));
        }
      }
    }
    const ports = {};
    for (const c of spec?.claims ?? []) {
      const m = c.match(/^port (\d+)$/);
      if (!m) continue;
      const P = Number(m[1]);
      let q = 30000 + ((P * 131 + k * 7919) % 25000);
      while (taken.has(q) || Object.values(ports).includes(q)) q = q + 1 < 55000 ? q + 1 : 30000;
      ports[P] = q;
    }
    return ports;
  }

  // What keeps a first copy of a project off a machine: another project placed there publishes one of the same host
  // ports, or uses the same container name (the second one to start would fail). { what, other }, or null.
  clash(name, machine) {
    const p = this.projects.get(name);
    const mine = p && this.version(name, p.version)?.claims;
    if (!mine?.length) return null;
    for (const [other, list] of this.copies) {
      if (other === name) continue;
      for (const x of list) {
        if (x.machine !== machine) continue;
        const what = this.copyClaims(other, x).find((c) => mine.includes(c));
        if (what) return { what, other };
      }
    }
    return null;
  }

  // The machine with the most room for a copy of the project: ready machines first, then machines without a copy of
  // it (a second copy there only when every machine has one, and the project can run twice on a machine), then by
  // load. Machines where a first copy would clash with another project's ports are out.
  bestMachine(name, up, counts, now) {
    const p = this.projects.get(name);
    const spec = p && this.version(name, p.version);
    const mine = new Map(); // machine -> copies of this project there (ones moving away included: their ports are still in use)
    for (const x of this.copiesOf(name)) mine.set(x.machine, (mine.get(x.machine) ?? 0) + 1);
    return [...up.values()]
      .filter((r) => (mine.get(r.machine) ? !spec?.nodup : !this.clash(name, r.machine)))
      .map((r) => ({ machine: r.machine, ready: r.ready, doubling: mine.get(r.machine) ?? 0, ...this.load(r.machine, counts.get(r.machine) ?? 0, now) }))
      .sort((a, b) => b.ready - a.ready || a.doubling - b.doubling || a.score - b.score)[0] ?? null;
  }

  liveMachines(now) {
    const up = new Map();
    for (const r of this.liveRuns(now)) if ((up.get(r.machine)?.started ?? -1) < r.started) up.set(r.machine, r);
    return up;
  }

  placementCounts() {
    const counts = new Map();
    for (const list of this.copies.values()) for (const x of list) if (!x.leaving) counts.set(x.machine, (counts.get(x.machine) ?? 0) + 1);
    return counts;
  }

  // Move one copy of a project off a machine (replica k, or the first copy there): the new copy is placed first, and
  // the old one is dropped once the new one is healthy (see place()). `to` picks the destination; otherwise it's the
  // machine with the most room.
  move(name, from, to, replica = null) {
    const p = this.project(name);
    const now = Date.now();
    const onFrom = this.copiesOn(name, from);
    const x = replica != null ? onFrom.find((y) => y.replica === Number(replica)) : onFrom.find((y) => !y.leaving) ?? onFrom[0];
    if (!x) throw new HttpError(400, replica != null ? `replica ${replica} of ${name} isn't on machine ${from}` : `${name} isn't placed on machine ${from}`);
    if (x.leaving) throw new HttpError(409, `replica ${x.replica} of ${name} is already moving from machine ${from} to ${x.leaving.to}`);
    const spec = this.version(name, p.version);
    const up = this.liveMachines(now);
    let dest;
    if (to) {
      const m = Number(to);
      if (!up.has(m)) throw new HttpError(400, `machine ${to} isn't up`);
      if (m === from) throw new HttpError(400, `replica ${x.replica} of ${name} is on machine ${to} already`);
      const doubling = this.copiesOn(name, m).length;
      if (doubling && spec?.nodup) throw new HttpError(409, `machine ${to} already runs ${name}, which can't run twice on one machine (${spec.nodup})`);
      const clash = !doubling && this.clash(name, m);
      if (clash) throw new HttpError(409, `machine ${to} already has ${clash.other}, which uses ${clash.what} too`);
      dest = { machine: m, doubling, reason: `moved here from machine ${from} by hand` };
    } else {
      const best = this.bestMachine(name, new Map([...up].filter(([m]) => m !== from)), this.placementCounts(), now);
      if (!best) throw new HttpError(409, `no other machine is up for ${name}`);
      dest = { ...best, reason: `moved here from machine ${from}: ${best.reason}` };
    }
    this.saveCopy(name, this.newCopy(name, spec, x.replica, dest, now, dest.reason));
    this.saveCopy(name, { ...x, leaving: { to: dest.machine, at: now } });
    return this.describe(p);
  }

  // Move every copy off a machine (it's hot, or about to be removed).
  evict(machine) {
    const moved = [];
    const failed = [];
    for (const [name, list] of this.copies) {
      for (const x of [...list]) {
        if (x.machine !== machine || x.leaving) continue;
        try {
          this.move(name, machine, null, x.replica);
          moved.push(copyKey(name, x.replica));
        } catch (e) {
          failed.push(`${copyKey(name, x.replica)}: ${e.message}`);
        }
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

  // The placed copy using the most of a machine, by its project's CPU and memory there (two copies of one project
  // share its figures; the highest replica number is the one to move).
  heaviestOn(machine, now) {
    const m = this.liveMetrics.get(machine);
    const memTotal = m?.h.memTotal || 1;
    let best = null;
    for (const [name, list] of this.copies) {
      const here = list.filter((x) => x.machine === machine && !x.leaving);
      if (!here.length) continue;
      if (now - (this.autoMoved.get(name) ?? 0) < PROJECT_COOLDOWN_MS) continue;
      const a = m?.a[name];
      const weight = a ? (a.cpu || 0) + (100 * (a.mem || 0)) / memTotal : 0;
      if (!best || weight > best.weight) best = { name, weight, replica: Math.max(...here.map((x) => x.replica)) };
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
    for (const list of this.copies.values()) for (const x of list) if (x.leaving) return;
    const up = this.liveMachines(now);
    const settled = [...up.values()].filter((r) => r.ready && now - r.started > SETTLED_MS && this.liveMetrics.has(r.machine));
    if (settled.length < 2) return;
    const counts = this.placementCounts();
    const tryMove = (name, from, dest, replica, why, reasonOnDest) => {
      try {
        this.move(name, from, String(dest.machine), replica);
        const x = this.copiesOn(name, dest.machine).find((y) => y.replica === replica);
        x.reason = `moved here from machine ${from} automatically: ${why}; ${reasonOnDest}`;
        this.saveCopy(name, x);
        this.autoMoved.set(name, now);
        this.logRebalance(now, `moved ${copyKey(name, replica)} from machine ${from} to machine ${dest.machine}: ${why}`);
      } catch (e) {
        this.logRebalance(now, `couldn't move ${copyKey(name, replica)} off machine ${from}: ${e.message}`);
      }
    };
    // First: a machine running two copies of a project while a settled machine with room runs none of it.
    for (const [name, list] of this.copies) {
      if (now - (this.autoMoved.get(name) ?? 0) < PROJECT_COOLDOWN_MS) continue;
      const by = new Map();
      for (const x of list) if (!x.leaving) by.set(x.machine, (by.get(x.machine) ?? 0) + 1);
      const from = [...by].filter(([m, n]) => n > 1 && settled.some((r) => r.machine === m)).sort((a, b) => b[1] - a[1])[0];
      if (!from) continue;
      const dest = settled.find((r) => !by.has(r.machine) && this.hasRoom(r.machine, now) && !this.clash(name, r.machine));
      if (!dest) continue;
      const replica = Math.max(...list.filter((x) => x.machine === from[0] && !x.leaving).map((x) => x.replica));
      return tryMove(name, from[0], dest, replica, `machine ${from[0]} ran ${from[1]} copies of ${name} and machine ${dest.machine} none`, this.load(dest.machine, counts.get(dest.machine) ?? 0, now).reason);
    }
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
      why = `machine ${from} has ${most.n} ${most.n === 1 ? "copy" : "copies"} placed and the emptiest machine has ${least.n}`;
    }
    const pick = this.heaviestOn(from, now);
    if (!pick) return;
    const dest = this.bestMachine(pick.name, new Map([...up].filter(([m]) => m !== from && this.hasRoom(m, now) && settled.some((r) => r.machine === m))), counts, now);
    if (!dest) {
      if (now - (this.rebalanceLog[0]?.t ?? 0) > COOLDOWN_MS * 3) this.logRebalance(now, `${why}, but no machine has room for ${pick.name}`);
      return;
    }
    tryMove(pick.name, from, dest, pick.replica, why, dest.reason);
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
    const label = String(body.label ?? "").slice(0, 80) || null;
    const starts = body.starts !== false; // agents from before this field could all start machines
    this.askPoolSize(pool, body.poolSize);
    let r = this.runs.get(run);
    if (!r) {
      const agent = String(body.agent ?? run).slice(0, 100);
      r = { id: run, machine, started, status, ready, handover: 0, retire: 0, seen: now, agent, label, pool, drain: 0, starts };
      this.saveRun(r);
    } else {
      const changed = ready !== r.ready || JSON.stringify(status) !== JSON.stringify(r.status) ||
        pool !== (r.pool ?? null) || label !== (r.label ?? null);
      Object.assign(r, { status, ready, seen: now, pool, label });
      r.starts = starts; // sent with every check-in, so it's kept in memory only
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
    if (!r.retire && !this.settling(now) && (this.surplusInPool(r, now) || this.superseded(r, now))) {
      r.retire = 1;
      this.saveRun(r);
    }
    const handover = !r.retire && this.wantsHandover(r, now);
    const start = !r.retire && r.ready && r.pool && r.starts ? this.claimStarts(r.pool, run, now) : []; // pool members start their peers
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
    const agent = body?.agent != null ? String(body.agent) : null;
    const machine = Number(body?.machine);
    const runs = [...this.runs.values()].filter((x) => this.live(x, now) && !x.retire &&
      ((runId && x.id === runId) || (agent && x.agent === agent) || (Number.isInteger(machine) && x.machine === machine)));
    if (!runs.length) throw new HttpError(404, "no live run matches that run, agent or machine");
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
    r.handover = now; // its replacement joins for this slot while this run is still up (join() allows that)
    this.saveRun(r);
    return true;
  }

  // Machines to start so a pool has its size. Whoever asks (a member of the pool, or something watching it from
  // outside through /api/claim) starts them, each with the slot it should take; the slot is held until it shows up.
  claimStarts(pool, by, now) {
    if (!pool || !(pool in this.pools())) return [];
    const live = this.liveRuns(now);
    if (this.settling(now)) return []; // claiming now would start a whole pool's worth of extras
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
    if (Number.isInteger(want) && want >= 1 && want <= max) {
      // A slot with another agent's live run in it is only given out when a machine was asked for there: a replacement
      // for a run that's handing over, or a start claimed for the slot. The join token alone mustn't take over a live
      // machine's tunnel.
      const others = this.liveRuns(now).filter((x) => x.machine === want && x.agent !== agent);
      const asked = others.every((x) => x.handover) || now - (this.starts.get(want) ?? 0) < START_WAIT_MS;
      if (others.length && !asked) throw new HttpError(409, `machine ${want} is up and hasn't asked for a replacement`);
      slot = want;
    } else {
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
      // Its <project>-m<n> names first: the regular DNS sync only touches records of tunnels it still knows.
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
    for (const [name, list] of this.copies) for (const x of [...list]) if (x.machine === n) this.dropCopy(name, n, x.replica);
    this.scheduleDns();
    return { retired: n, tunnel: slot?.tunnel ?? null };
  }

  // For the public URLs, the machines each may go to: "<project>-<k>" -> replica k's machine if its current run is
  // online and has the project healthy, plus the old copy while it's being moved, after the new one. Disabled projects
  // are there with no machines. (A machine keeps reporting a project healthy for a moment after it's told to remove it.)
  healthyRoutes(now) {
    const newest = new Map();
    for (const r of this.liveRuns(now)) {
      if (r.ready && (newest.get(r.machine)?.started ?? -1) < r.started) newest.set(r.machine, r);
    }
    const healthy = (key, machine) => newest.get(machine)?.status[key]?.s === "healthy";
    const replicas = {};
    for (const p of this.projects.values()) {
      const spec = this.version(p.name, p.version);
      if (!spec?.port) continue;
      for (let k = 1; k <= spec.replicas; k++) replicas[`${p.name}-${k}`] = [];
      if (!p.enabled) continue;
      const copies = [...this.copiesOf(p.name)].sort((a, b) => Boolean(a.leaving) - Boolean(b.leaving));
      for (const x of copies) if (healthy(copyKey(p.name, x.replica), x.machine)) replicas[`${p.name}-${x.replica}`]?.push(x.machine);
    }
    return { replicas };
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
    this.sql.exec("DELETE FROM metrics_10m WHERE t < ? AND t < ?", now - KEEP_10M_MS, Number(this.settings.get("rolled60") ?? 0)); // once rolled into hours
    this.sql.exec("DELETE FROM metrics_1h WHERE t < ?", now - KEEP_1H_MS);
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
      // A late minute in an already rolled-up 10-minute bucket: roll that bucket up again, and its hour if that's done too.
      const ten = t - (t % (10 * MIN));
      if (ten <= Number(this.settings.get("rolled10") ?? 0)) {
        this.rollupBucket("metrics_10m", "metrics_1m", ten, 10 * MIN);
        const hour = t - (t % (60 * MIN));
        if (hour <= Number(this.settings.get("rolled60") ?? 0)) this.rollupBucket("metrics_1h", "metrics_10m", hour, 60 * MIN);
      }
    }
  }

  // One row of `table` for the bucket starting at b, from the finer rows of `from` within it.
  rollupBucket(table, from, b, step) {
    const rows = this.all(`SELECT data FROM ${from} WHERE t >= ? AND t < ?`, b, b + step).map((r) => JSON.parse(r.data));
    if (!rows.length) return;
    this.sql.exec(`INSERT INTO ${table} (t, data) VALUES (?, ?) ON CONFLICT (t) DO UPDATE SET data = excluded.data`, b, JSON.stringify(mergeFleet(rows)));
  }

  // 10-minute rows for every bucket whose minutes are all written, then hourly rows for every hour whose 10-minute
  // buckets are all there.
  rollupMetrics(now) {
    const ten = 10 * MIN;
    const hour = 60 * MIN;
    let last10 = Number(this.settings.get("rolled10") ?? 0);
    if (!last10) last10 = now - (now % ten) - 2 * ten;
    for (let b = last10 + ten, n = 0; b + ten + FLUSH_AFTER_MS <= now && n < 300; b += ten, n++) {
      this.rollupBucket("metrics_10m", "metrics_1m", b, ten);
      last10 = b;
    }
    if (String(last10) !== this.settings.get("rolled10")) this.setSetting("rolled10", last10);
    let last60 = Number(this.settings.get("rolled60") ?? 0);
    if (!last60) { // the first time, start from the oldest 10-minute row, so the history already there gets its hours
      const oldest = this.all("SELECT MIN(t) AS t FROM metrics_10m")[0]?.t;
      last60 = (oldest ? oldest - (oldest % hour) : now - (now % hour)) - hour;
    }
    for (let b = last60 + hour, n = 0; b + hour <= last10 + ten && n < 300; b += hour, n++) {
      this.rollupBucket("metrics_1h", "metrics_10m", b, hour);
      last60 = b;
    }
    if (String(last60) !== this.settings.get("rolled60")) this.setSetting("rolled60", last60);
  }

  // Columns for charts: t[i], and for each machine its host fields and each app's fields as arrays aligned to t.
  history(rangeName, now) {
    const [span, step, table] = RANGES[rangeName];
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
    return { step, t, m: machines };
  }

  // The newest sample from every machine that's reporting.
  liveNow(now) {
    const live = {};
    for (const [m, x] of this.liveMetrics) {
      const r = this.runs.get(x.run);
      if (now - x.t > LIVE_MS || !r) continue;
      live[m] = { ...x, ready: Boolean(r.ready), status: r.status, label: r.label };
    }
    return live;
  }

  // The history is built at most every 15 s for the short ranges, every minute for the day, every 5 minutes for the
  // week and month (their rows only change hourly); the live part is fresh every time.
  metricsResponse(rangeName) {
    const range = RANGES[rangeName];
    if (!range) throw new HttpError(400, `range is one of ${Object.keys(RANGES).join(", ")}`);
    const now = Date.now();
    const ttl = range[1] >= 60 * MIN ? 5 * MIN : range[1] >= 10 * MIN ? MIN : 15_000;
    let c = this.metricsCache.get(rangeName);
    if (!c || now - c.at > ttl) {
      c = { at: now, history: this.history(rangeName, now) };
      this.metricsCache.set(rangeName, c);
    }
    return Response.json({
      now, range: rangeName, expected: this.expectedMachines(),
      projects: [...this.projects.values()].map((p) => this.describe(p)).sort((a, b) => a.name.localeCompare(b.name)),
      live: this.liveNow(now), ...c.history,
    }, { headers: { "cache-control": "no-store" } });
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
      starting: [...this.starts].filter(([n, at]) => now - at < START_WAIT_MS && !this.liveRuns(now).some((r) => r.machine === n)).map(([n]) => n),
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
          label: r.label,
          projects: r.status,
        })),
    };
  }

  // ---- DNS and routes ----
  // For every project with a port: <project>-<k>.DOMAIN (k from 1 to its replica count) -> this Worker (a proxied
  // placeholder record plus a Worker route), and <project>-m<n>.DOMAIN -> tunnel runner-<n> for every slot that has a
  // tunnel, which is how the Worker reaches machine n. Disabled projects keep theirs, so turning one back on is
  // instant. Names already used by records that aren't ours are left alone; placeholders and routes of ours for names
  // no longer served (a removed replica, the shared <project>.DOMAIN of before) are deleted.

  scheduleDns() {
    this.dnsDue = Date.now() + 2_000;
    this.ctx.storage.setAlarm(this.dnsDue);
  }

  // The alarm keeps DNS in line: hourly, or 2s after a change.
  async alarm() {
    const now = Date.now();
    if (now >= (this.dnsDue ?? 0)) {
      const due = this.dnsDue; // a change during the sync asks for another one (scheduleDns), which must stand
      try {
        await this.syncDns();
        this.dnsError = null;
        if (this.dnsDue === due) this.dnsDue = now + 3600_000; // re-check hourly in case something drifted
      } catch (e) {
        this.dnsError = e.message;
        console.log(`DNS sync failed: ${e.message}`);
        if (this.dnsDue === due) this.dnsDue = now + 60_000;
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
    const served = new Set(); // names this Worker answers: <project>-<k>.DOMAIN
    for (const p of this.projects.values()) {
      const spec = this.version(p.name, p.version);
      const port = spec?.port ?? (p.stable != null ? this.version(p.name, p.stable)?.port : null);
      if (!port) continue;
      const replicas = spec?.replicas ?? 1;
      for (let k = 1; k <= replicas; k++) served.add(`${p.name}-${k}.${domain}`);
      for (const [n, target] of tunnelOf) want.set(`${p.name}-m${n}.${domain}`, target);
    }
    const existing = [];
    for (let page = 1; ; page++) {
      const data = await this.cf(`/zones/${zone}/dns_records?per_page=1000&page=${page}`);
      existing.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    const isPlaceholder = (r) => r.type === "AAAA" && r.content === REPLICA_DNS && r.comment === "hetp4401/runner";
    const deletes = existing.filter((r) => (r.type === "CNAME" && ours.has(r.content) && !want.has(r.name)) || (isPlaceholder(r) && !served.has(r.name)));
    // Records on their way out don't keep a name from being used (machine n's old <project>-<n> becomes replica n's).
    const gone = new Set(deletes.map((r) => r.id));
    const byName = new Map();
    for (const r of existing) if (!gone.has(r.id)) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);
    const notes = [];
    const posts = [];
    const patches = [];
    for (const [name, content] of want) {
      const rs = byName.get(name) ?? [];
      const r = rs.find((x) => x.type === "CNAME");
      if (!rs.length) posts.push({ type: "CNAME", name, content, proxied: true, comment: "hetp4401/runner" });
      else if (r && r.content !== content && ours.has(r.content)) patches.push({ id: r.id, content });
    }
    const servable = new Set(); // names this Worker may answer
    for (const name of served) {
      const rs = byName.get(name) ?? [];
      if (!rs.length) posts.push({ type: "AAAA", name, content: REPLICA_DNS, proxied: true, comment: "hetp4401/runner" });
      else if (!rs.every(isPlaceholder)) {
        notes.push(`${name} is already used by another DNS record, so this Worker doesn't answer it`);
        continue;
      }
      servable.add(name);
    }
    // At most 100 changes per batch (the free plan's limit is 200), deletes first; a batch applies its own deletes
    // before its posts, and nothing at all if one change fails.
    const ops = [...deletes.map((r) => ["deletes", { id: r.id }]), ...patches.map((x) => ["patches", x]), ...posts.map((x) => ["posts", x])];
    for (let i = 0; i < ops.length; i += 100) {
      const batch = {};
      for (const [kind, x] of ops.slice(i, i + 100)) (batch[kind] ??= []).push(x);
      await this.cf(`/zones/${zone}/dns_records/batch`, { method: "POST", body: JSON.stringify(batch) });
    }
    // Worker routes for the names it answers.
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

// Control plane for hetp4401/runner.
// Holds the project specs (a docker compose file plus any Dockerfiles and build files), rolls each change out one
// machine at a time, tracks which machines are up and starts replacements, and keeps <project>-<n> DNS pointing at
// tunnel runner-<n>. The agent on every GitHub Actions machine checks in at /api/sync and gets back what it should run.
//   /            public status page          /api/*        API, Bearer token (admin, or node for sync/claim/roll)
//   /admin       admin portal                /admin/api/*  the same API, signed in with Cloudflare Access
import { DurableObject } from "cloudflare:workers";
import YAML from "yaml";
import ADMIN_PAGE from "./admin.html";
import { STATUS_PAGE } from "./status-page.js";

const POLL_S = 20; // how often agents check in
const LIVE_MS = 75_000; // a run counts as up if it checked in this recently
const START_WAIT_MS = 8 * 60_000; // after starting a machine, give it this long to show up before trying again
const HANDOVER_AFTER_MS = 315 * 60_000; // replace each machine after 5h15m; GitHub stops jobs at 6h
const HANDOVER_STUCK_MS = 15 * 60_000; // a handover slower than this stops holding up the other machines
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE_PATH = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;
const MAX_FILES = 30;
const MAX_SPEC_BYTES = 256_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => Response.json(data, { status });
const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const isMap = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

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
  let { compose = "", dockerfile = null, files = {}, port = null } = body;
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
  if (!compose.trim()) {
    if (!files.Dockerfile) throw new HttpError(400, "send a compose file, a Dockerfile, or both");
    // A Dockerfile on its own: build it and publish the port (the app should listen on it inside the container).
    compose = [
      ...(port ? ["x-runner:", `  port: ${port}`] : []),
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
  return { compose, port, files: sorted };
}

export default {
  fetch(request, env) {
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
    ]) {
      this.sql.exec(query);
    }
    // Columns added after the first release.
    const columns = (table) => new Set(this.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (!columns("projects").has("enabled")) this.sql.exec("ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    if (!columns("versions").has("files")) this.sql.exec("ALTER TABLE versions ADD COLUMN files TEXT");
    // Working state lives in memory (the object is single-threaded); SQLite keeps it across restarts,
    // which happen whenever Cloudflare lets the object sleep.
    this.projects = new Map(this.all("SELECT * FROM projects").map((p) => [p.name, p]));
    this.runs = new Map(this.all("SELECT * FROM runs").map((r) => [r.id, { ...r, status: JSON.parse(r.status), savedSeen: r.seen }]));
    this.starts = new Map(this.all("SELECT machine, at FROM starts").map((s) => [s.machine, s.at]));
    this.settings = new Map(this.all("SELECT key, value FROM settings").map((s) => [s.key, s.value]));
    this.versions = new Map(); // "name@version" -> { compose, port, files }
    this.accessKeys = new Map(); // Cloudflare Access signing keys, by key id
    this.lastCleanup = 0;
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

  machines() {
    return Number(this.settings.get("machines") ?? this.env.MACHINES ?? 10);
  }

  tunnels() {
    const t = this.env.TUNNELS ?? {};
    return typeof t === "string" ? JSON.parse(t) : t;
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
      const row = this.all("SELECT compose, port, files FROM versions WHERE name = ? AND version = ?", name, v)[0];
      this.versions.set(key, row && { compose: row.compose, port: row.port, files: JSON.parse(row.files ?? "{}") });
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
      `INSERT INTO runs (id, machine, started, status, ready, handover, retire, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, ready = excluded.ready,
         handover = excluded.handover, retire = excluded.retire, seen = excluded.seen`,
      r.id, r.machine, r.started, JSON.stringify(r.status), r.ready, r.handover, r.retire, r.seen,
    );
  }

  markStart(machine, at, by) {
    this.starts.set(machine, at);
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
      if (path.startsWith("/admin/api/")) {
        // The portal: Cloudflare Access signs people in in front of /admin; check its token here too.
        const auth = request.headers.get("authorization") ?? "";
        const signedIn = (this.env.ADMIN_TOKEN && auth === `Bearer ${this.env.ADMIN_TOKEN}`) || (await this.accessUser(request));
        if (!signedIn) throw new HttpError(401, "sign in again (reload the page)");
        const origin = request.headers.get("origin");
        if (request.method !== "GET" && origin && origin !== url.origin) throw new HttpError(403, "cross-site request refused");
        return await this.api(request, url, path.slice("/admin/api".length), { admin: true, node: true });
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

  async api(request, url, route, { admin, node }) {
    const { method } = request;
    const body = () => request.json().catch(() => {
      throw new HttpError(400, "the body must be JSON");
    });
    const need = (ok) => {
      if (!ok) throw new HttpError(401, "bad token");
    };
    if (method === "GET" && route === "/status") return json(this.status());
    if (method === "POST" && route === "/sync") return need(node), json(this.sync(await body()));
    if (method === "POST" && route === "/claim") return need(node), json({ start: this.claimStarts("watchdog", Date.now()) });
    if (method === "POST" && route === "/roll") return need(node), json(this.roll(url.searchParams.get("machine")));
    if (method === "PUT" && route === "/settings") return need(admin), json(this.putSettings(await body()));
    const m = route.match(/^\/projects\/([^/]+)(?:\/(enable|disable))?$/);
    if (m) {
      need(admin);
      const [, name, action] = m;
      if (action && method === "POST") return json(this.setEnabled(name, action === "enable"));
      if (!action && method === "GET") return json(this.getProject(name, url.searchParams.get("version")));
      if (!action && method === "PUT") return json(this.putProject(name, await body(), url.searchParams.has("now")));
      if (!action && method === "DELETE") return json(this.deleteProject(name));
    }
    throw new HttpError(404, "not found");
  }

  // Who signed in through Cloudflare Access, or null. Checks the token's signature, audience, issuer and expiry.
  async accessUser(request) {
    const token = request.headers.get("cf-access-jwt-assertion");
    const { ACCESS_TEAM: team, ACCESS_AUD: aud } = this.env;
    if (!token || !team || !aud) return null;
    try {
      const [h, p, sig] = token.split(".");
      const header = JSON.parse(new TextDecoder().decode(b64url(h)));
      const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
      if (claims.iss !== `https://${team}` || claims.exp * 1000 < Date.now()) return null;
      if (![].concat(claims.aud).includes(aud)) return null;
      if (!this.accessKeys.has(header.kid)) {
        const { keys } = await (await fetch(`https://${team}/cdn-cgi/access/certs`)).json();
        for (const k of keys) {
          const key = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
          this.accessKeys.set(k.kid, key);
        }
      }
      const key = this.accessKeys.get(header.kid);
      const ok = key && (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`)));
      return ok ? claims.email || claims.common_name || "signed in" : null;
    } catch {
      return null;
    }
  }

  // ---- projects ----

  describe(p) {
    const machines = this.machines();
    const latest = this.version(p.name, p.version);
    return {
      name: p.name,
      version: p.version,
      stable: p.stable,
      port: latest?.port ?? null,
      files: Object.keys(latest?.files ?? {}),
      enabled: Boolean(p.enabled),
      state: !p.enabled ? "disabled" : p.halted ? "halted" : p.stable === p.version ? "live" : "rolling out",
      rollout: Math.min(p.rollout, machines),
      machines,
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
      versions: this.all("SELECT version, port, created FROM versions WHERE name = ? ORDER BY version", name),
    };
  }

  // A new spec becomes a new version, which rolls out machine by machine (or everywhere at once with ?now).
  putProject(name, body, now) {
    if (!NAME.test(name)) throw new HttpError(400, "project names are lowercase letters, digits and dashes");
    const spec = buildSpec(body);
    const t = Date.now();
    const machines = this.machines();
    const p = this.projects.get(name);
    const latest = p && this.version(name, p.version);
    const same = latest && latest.compose === spec.compose && latest.port === spec.port &&
      JSON.stringify(latest.files) === JSON.stringify(spec.files);
    let next;
    if (same) {
      // Same spec again: that retries a stopped rollout, or (?now) pushes it to every machine.
      if (!p.halted && !now) return { ...this.describe(p), unchanged: true };
      next = { ...p, halted: null, rollout: now ? machines : 1, stable: now ? p.version : p.stable, updated: t };
    } else {
      const version = (p?.version ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO versions (name, version, compose, port, files, created) VALUES (?, ?, ?, ?, ?, ?)",
        name, version, spec.compose, spec.port, JSON.stringify(spec.files), t,
      );
      next = {
        name, version, stable: now ? version : (p?.stable ?? null), rollout: now ? machines : 1, halted: null,
        updated: t, enabled: p?.enabled ?? 1,
      };
    }
    this.saveProject(next);
    this.scheduleDns();
    return this.describe(next);
  }

  // Disabled projects stay in the list with their versions, but no machine runs them.
  setEnabled(name, enabled) {
    const p = this.project(name);
    this.saveProject({ ...p, enabled: enabled ? 1 : 0, updated: Date.now() });
    return this.describe(this.projects.get(name));
  }

  deleteProject(name) {
    this.project(name);
    this.projects.delete(name);
    this.sql.exec("DELETE FROM projects WHERE name = ?", name);
    this.sql.exec("DELETE FROM versions WHERE name = ?", name);
    for (const key of this.versions.keys()) if (key.startsWith(`${name}@`)) this.versions.delete(key);
    this.scheduleDns();
    return { deleted: name };
  }

  putSettings(body) {
    const { machines } = isMap(body) ? body : {};
    if (machines !== undefined) {
      const max = Object.keys(this.tunnels()).length;
      if (!(Number.isInteger(machines) && machines >= 0 && machines <= max)) {
        throw new HttpError(400, `machines must be 0-${max} (one per tunnel)`);
      }
      this.setSetting("machines", machines);
      this.scheduleDns();
    }
    return { machines: this.machines() };
  }

  // Replace machines one at a time (all of them, or just one), e.g. after the agent code changes.
  roll(machine) {
    const now = Date.now();
    this.setSetting(machine ? `roll_${Number(machine)}` : "roll", now);
    return { rolling: machine ? [Number(machine)] : "all", since: now };
  }

  // What machine n should run: the new version on machines 1..rollout, the last good one everywhere else.
  // A halted rollout sends every machine back to the last good version; disabled projects run nowhere.
  desiredFor(machine) {
    const out = {};
    for (const p of this.projects.values()) {
      if (!p.enabled) continue;
      const v = !p.halted && machine <= p.rollout ? p.version : p.stable;
      if (v == null) continue;
      const { compose, port, files } = this.version(p.name, v);
      out[p.name] = { v, compose, port, files };
    }
    return out;
  }

  // Move each rollout on to the next machine once every machine so far runs the new version healthily;
  // stop it as soon as one of them reports the new version failed.
  advanceRollouts(now) {
    const machines = this.machines();
    const newest = new Map(); // machine -> its newest run that's up; that's the one that speaks for the machine
    for (const r of this.liveRuns(now)) {
      if (r.machine <= machines && (newest.get(r.machine)?.started ?? -1) < r.started) newest.set(r.machine, r);
    }
    if (!newest.size) return; // nothing is up to try a new version on
    for (const p of this.projects.values()) {
      if (!p.enabled || p.halted || p.stable === p.version) continue;
      let k = p.rollout;
      let changed = false;
      for (;;) {
        const group = [...newest.values()].filter((r) => r.machine <= k);
        const failed = group.find((r) => r.status[p.name]?.v === p.version && r.status[p.name]?.s === "failed");
        if (failed) {
          p.halted = `machine ${failed.machine}: ${failed.status[p.name].e || "failed"}`.slice(0, 600);
          changed = true;
          break;
        }
        if (!group.every((r) => r.status[p.name]?.v === p.version && r.status[p.name]?.s === "healthy")) break;
        if (k >= machines) {
          p.stable = p.version;
          changed = true;
          break;
        }
        k++;
      }
      if (k !== p.rollout || changed) {
        Object.assign(p, { rollout: k, updated: now });
        this.saveProject(p);
      }
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
    let r = this.runs.get(run);
    if (!r) {
      r = { id: run, machine, started, status, ready, handover: 0, retire: 0, seen: now };
      this.saveRun(r);
    } else {
      const changed = ready !== r.ready || JSON.stringify(status) !== JSON.stringify(r.status);
      Object.assign(r, { status, ready, seen: now });
      // Write when something changed, and "last seen" at most every 30s, to keep storage writes low.
      if (changed || now - r.savedSeen > 30_000) this.saveRun(r);
    }
    this.advanceRollouts(now);
    if (!r.retire && (machine > this.machines() || this.superseded(r, now))) {
      r.retire = 1;
      this.saveRun(r);
    }
    const handover = !r.retire && this.wantsHandover(r, now);
    const start = !r.retire && r.ready ? this.claimStarts(run, now) : [];
    this.cleanup(now);
    return {
      domain: this.env.DOMAIN,
      poll: POLL_S,
      desired: machine <= this.machines() ? this.desiredFor(machine) : {},
      retire: Boolean(r.retire),
      handover,
      start,
    };
  }

  // A run can go once a newer run of the same machine is online and healthy on everything it should run.
  superseded(r, now) {
    const desired = Object.entries(this.desiredFor(r.machine));
    return this.liveRuns(now).some((x) => x.machine === r.machine && x.started > r.started && x.ready &&
      desired.every(([name, d]) => x.status[name]?.v === d.v && x.status[name]?.s === "healthy"));
  }

  // Ask a run to start its own replacement when it's near GitHub's 6-hour limit (or a roll was requested).
  // One machine at a time, oldest first, so at most one machine is ever changing over.
  wantsHandover(r, now) {
    const rollAll = Number(this.settings.get("roll") ?? 0);
    const due = (x) => now - x.started > HANDOVER_AFTER_MS || x.started < rollAll ||
      x.started < Number(this.settings.get(`roll_${x.machine}`) ?? 0);
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

  // Machines that should be running but aren't. Whoever asks (an agent or the watchdog workflow) starts them.
  claimStarts(by, now) {
    const live = this.liveRuns(now);
    const out = [];
    for (let m = 1; m <= this.machines(); m++) {
      if (live.some((x) => x.machine === m) || now - (this.starts.get(m) ?? 0) < START_WAIT_MS) continue;
      this.markStart(m, now, by);
      out.push(m);
    }
    return out;
  }

  cleanup(now) {
    if (now - this.lastCleanup < 10 * 60_000) return;
    this.lastCleanup = now;
    for (const r of this.runs.values()) {
      if (now - r.seen > 2 * 3600_000) {
        this.runs.delete(r.id);
        this.sql.exec("DELETE FROM runs WHERE id = ?", r.id);
      }
    }
  }

  status() {
    const now = Date.now();
    return {
      now,
      repo: this.env.REPO,
      domain: this.env.DOMAIN,
      machines: this.machines(),
      dnsError: this.dnsError,
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
          projects: r.status,
        })),
    };
  }

  // ---- DNS: <project>-<n>.DOMAIN -> tunnel runner-<n>, for every project with a port ----
  // Disabled projects keep their records, so turning one back on is instant.

  scheduleDns() {
    this.ctx.storage.setAlarm(Date.now() + 2_000);
  }

  async alarm() {
    try {
      await this.syncDns();
      this.dnsError = null;
      await this.ctx.storage.setAlarm(Date.now() + 3600_000); // re-check hourly in case something drifted
    } catch (e) {
      this.dnsError = e.message;
      console.log(`DNS sync failed: ${e.message}`);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async syncDns() {
    const tunnels = this.tunnels();
    const domain = this.env.DOMAIN;
    const ours = new Set(Object.values(tunnels).map((t) => `${t}.cfargotunnel.com`));
    const want = new Map();
    for (const p of this.projects.values()) {
      const port = this.version(p.name, p.version)?.port ?? (p.stable != null ? this.version(p.name, p.stable)?.port : null);
      if (!port) continue;
      for (let m = 1; m <= this.machines(); m++) {
        if (tunnels[m]) want.set(`${p.name}-${m}.${domain}`, `${tunnels[m]}.cfargotunnel.com`);
      }
    }
    const api = async (path, init = {}) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.env.ZONE}/dns_records${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.env.CF_DNS_TOKEN}`, "content-type": "application/json" },
      });
      const data = await res.json();
      if (!data.success) throw new Error(`Cloudflare DNS API: ${JSON.stringify(data.errors)}`);
      return data;
    };
    const existing = [];
    for (let page = 1; ; page++) {
      const data = await api(`?type=CNAME&per_page=1000&page=${page}`);
      existing.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    const byName = new Map(existing.map((r) => [r.name, r]));
    const batch = { deletes: [], posts: [], patches: [] };
    for (const r of existing) if (ours.has(r.content) && !want.has(r.name)) batch.deletes.push({ id: r.id });
    for (const [name, content] of want) {
      const r = byName.get(name);
      if (!r) batch.posts.push({ type: "CNAME", name, content, proxied: true, comment: "hetp4401/runner" });
      else if (r.content !== content && ours.has(r.content)) batch.patches.push({ id: r.id, content });
      // A record with this name that points somewhere else isn't ours, so it's left alone.
    }
    if (batch.deletes.length || batch.posts.length || batch.patches.length) {
      await api("/batch", { method: "POST", body: JSON.stringify(batch) });
    }
  }
}

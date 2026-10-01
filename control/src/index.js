// Control plane for hetp4401/runner.
// Holds the project specs (docker compose files), rolls each change out one machine at a time,
// tracks which machines are up and starts replacements, and keeps <project>-<n> DNS pointing at tunnel runner-<n>.
// The agent on every GitHub Actions machine checks in at /api/sync and gets back what it should be running.
import { DurableObject } from "cloudflare:workers";

const POLL_S = 20; // how often agents check in
const LIVE_MS = 75_000; // a run counts as up if it checked in this recently
const START_WAIT_MS = 8 * 60_000; // after starting a machine, give it this long to show up before trying again
const HANDOVER_AFTER_MS = 315 * 60_000; // replace each machine after 5h15m; GitHub stops jobs at 6h
const HANDOVER_STUCK_MS = 15 * 60_000; // a handover slower than this stops holding up the other machines
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => Response.json(data, { status });

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
    // Working state lives in memory (the object is single-threaded); SQLite keeps it across restarts,
    // which happen whenever Cloudflare lets the object sleep.
    this.projects = new Map(this.all("SELECT * FROM projects").map((p) => [p.name, p]));
    this.runs = new Map(this.all("SELECT * FROM runs").map((r) => [r.id, { ...r, status: JSON.parse(r.status), savedSeen: r.seen }]));
    this.starts = new Map(this.all("SELECT machine, at FROM starts").map((s) => [s.machine, s.at]));
    this.settings = new Map(this.all("SELECT key, value FROM settings").map((s) => [s.key, s.value]));
    this.versions = new Map(); // "name@version" -> { compose, port }
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
      this.versions.set(key, this.all("SELECT compose, port FROM versions WHERE name = ? AND version = ?", name, v)[0]);
    }
    return this.versions.get(key);
  }

  saveProject(p) {
    this.projects.set(p.name, p);
    this.sql.exec(
      `INSERT INTO projects (name, version, stable, rollout, halted, updated) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET version = excluded.version, stable = excluded.stable,
         rollout = excluded.rollout, halted = excluded.halted, updated = excluded.updated`,
      p.name, p.version, p.stable, p.rollout, p.halted, p.updated,
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

  async fetch(request) {
    const url = new URL(request.url);
    const { method } = request;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const auth = request.headers.get("authorization") ?? "";
    const admin = Boolean(this.env.ADMIN_TOKEN) && auth === `Bearer ${this.env.ADMIN_TOKEN}`;
    const node = admin || (Boolean(this.env.NODE_TOKEN) && auth === `Bearer ${this.env.NODE_TOKEN}`);
    const body = () => request.json().catch(() => {
      throw new HttpError(400, "the body must be JSON");
    });
    try {
      if (method === "GET" && path === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (method === "GET" && path === "/api/status") return json(this.status());
      if (method === "POST" && ["/api/sync", "/api/claim", "/api/roll"].includes(path)) {
        if (!node) throw new HttpError(401, "bad token");
        if (path === "/api/sync") return json(this.sync(await body()));
        if (path === "/api/claim") return json({ start: this.claimStarts("watchdog", Date.now()) });
        return json(this.roll(url.searchParams.get("machine")));
      }
      const project = path.match(/^\/api\/projects\/([^/]+)$/)?.[1];
      if (project || path === "/api/settings") {
        if (!admin) throw new HttpError(401, "bad token");
        if (path === "/api/settings" && method === "PUT") return json(this.putSettings(await body()));
        if (project && method === "GET") return json(this.getProject(project));
        if (project && method === "PUT") return json(this.putProject(project, await body(), url.searchParams.has("now")));
        if (project && method === "DELETE") return json(this.deleteProject(project));
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      return json({ error: e.message }, e.status ?? 500);
    }
  }

  // ---- projects ----

  describe(p) {
    const machines = this.machines();
    return {
      name: p.name,
      version: p.version,
      stable: p.stable,
      port: this.version(p.name, p.version)?.port ?? null,
      state: p.halted ? "halted" : p.stable === p.version ? "live" : "rolling out",
      rollout: Math.min(p.rollout, machines),
      machines,
      halted: p.halted,
      updated: p.updated,
    };
  }

  getProject(name) {
    const p = this.projects.get(name);
    if (!p) throw new HttpError(404, `no project called ${name}`);
    return {
      ...this.describe(p),
      compose: this.version(name, p.version).compose,
      versions: this.all("SELECT version, port, created FROM versions WHERE name = ? ORDER BY version", name),
    };
  }

  // A new spec becomes a new version, which rolls out machine by machine (or everywhere at once with ?now).
  putProject(name, body, now) {
    const { compose, port = null } = body ?? {};
    if (!NAME.test(name)) throw new HttpError(400, "project names are lowercase letters, digits and dashes");
    if (typeof compose !== "string" || !compose.trim()) {
      throw new HttpError(400, "compose (the docker compose file, as text) is required");
    }
    if (compose.length > 100_000) throw new HttpError(400, "compose is too big");
    if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      throw new HttpError(400, "port must be a whole number from 1 to 65535");
    }
    const t = Date.now();
    const machines = this.machines();
    const p = this.projects.get(name);
    const latest = p && this.version(name, p.version);
    let next;
    if (latest && latest.compose === compose && latest.port === port) {
      // Same spec again: that retries a stopped rollout, or (?now) pushes it to every machine.
      if (!p.halted && !now) return { ...this.describe(p), unchanged: true };
      next = { ...p, halted: null, rollout: now ? machines : 1, stable: now ? p.version : p.stable, updated: t };
    } else {
      const version = (p?.version ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO versions (name, version, compose, port, created) VALUES (?, ?, ?, ?, ?)",
        name, version, compose, port, t,
      );
      next = { name, version, stable: now ? version : (p?.stable ?? null), rollout: now ? machines : 1, halted: null, updated: t };
    }
    this.saveProject(next);
    this.scheduleDns();
    return this.describe(next);
  }

  deleteProject(name) {
    if (!this.projects.has(name)) throw new HttpError(404, `no project called ${name}`);
    this.projects.delete(name);
    this.sql.exec("DELETE FROM projects WHERE name = ?", name);
    this.sql.exec("DELETE FROM versions WHERE name = ?", name);
    for (const key of this.versions.keys()) if (key.startsWith(`${name}@`)) this.versions.delete(key);
    this.scheduleDns();
    return { deleted: name };
  }

  putSettings({ machines } = {}) {
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
  // A halted rollout sends every machine back to the last good version.
  desiredFor(machine) {
    const out = {};
    for (const p of this.projects.values()) {
      const v = !p.halted && machine <= p.rollout ? p.version : p.stable;
      if (v == null) continue;
      const { compose, port } = this.version(p.name, v);
      out[p.name] = { v, compose, port };
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
      if (p.halted || p.stable === p.version) continue;
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
    const status = body.status && typeof body.status === "object" ? body.status : {};
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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runner</title>
<style>
  :root { --bg: #f7f7f5; --card: #fff; --fg: #1c1b19; --muted: #6f6b66; --line: #e6e3df; --ok: #177245; --warn: #a15c00; --bad: #b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121110; --card: #1b1a18; --fg: #f1efec; --muted: #a29d97; --line: #2c2a27; --ok: #5bd394; --warn: #f2b84b; --bad: #ff8a7a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 40px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 13px; margin: 28px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .sub { color: var(--muted); margin-top: 2px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; font-weight: 600; color: var(--muted); }
  tr:last-child td { border-bottom: 0; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .links a { margin-right: 6px; }
  a { color: inherit; }
  .chip { display: inline-block; margin: 0 8px 2px 0; white-space: nowrap; }
  .err { color: var(--bad); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>Runner</h1>
  <div class="sub" id="sub">Loading…</div>
  <h2>Projects</h2>
  <div class="card"><table id="projects"></table></div>
  <h2>Machines</h2>
  <div class="card"><table id="machines"></table></div>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h"; };
const STATE = { healthy: "ok", applying: "warn", failed: "bad" };
async function load() {
  let d;
  try { d = await (await fetch("/api/status", { cache: "no-store" })).json(); }
  catch { document.getElementById("sub").textContent = "Can't reach the control plane"; return; }
  const up = new Set(d.runs.filter((r) => r.live && !r.retiring).map((r) => r.machine));
  document.getElementById("sub").textContent = up.size + " of " + d.machines + " machines up" + (d.dnsError ? " · DNS: " + d.dnsError : "");
  document.getElementById("projects").innerHTML = "<tr><th>Project</th><th>Version</th><th>State</th><th>Open</th></tr>" +
    (d.projects.map((p) => {
      const state = p.state === "live" ? '<span class="ok">live</span>'
        : p.state === "halted" ? '<span class="bad">halted, every machine is back on v' + esc(p.stable ?? "-") + '</span><div class="err">' + esc(p.halted) + "</div>"
        : '<span class="warn">rolling out: ' + p.rollout + " of " + p.machines + " machines</span>";
      const links = p.port ? Array.from({ length: p.machines }, (_, i) => '<a href="https://' + p.name + "-" + (i + 1) + "." + d.domain + '/" target="_blank">' + (i + 1) + "</a>").join("") : '<span class="muted">no port</span>';
      return "<tr><td><b>" + esc(p.name) + "</b></td><td>v" + p.version + (p.stable && p.stable !== p.version ? ' <span class="muted">(v' + p.stable + " elsewhere)</span>" : "") +
        "</td><td>" + state + '</td><td class="links">' + links + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="muted">No projects yet</td></tr>');
  document.getElementById("machines").innerHTML = "<tr><th>Machine</th><th>Run</th><th>State</th><th>Projects</th></tr>" +
    (d.runs.map((r) => {
      const state = !r.live ? '<span class="muted">gone (seen ' + ago(d.now - r.seen) + " ago)</span>"
        : r.retiring ? '<span class="muted">leaving, replaced</span>'
        : r.handover ? '<span class="warn">starting its replacement</span>'
        : r.ready ? '<span class="ok">online</span> <span class="muted">' + ago(d.now - r.started) + "</span>"
        : '<span class="warn">starting up</span>';
      const projects = Object.entries(r.projects).map(([name, s]) =>
        '<span class="chip"><span class="' + (STATE[s.s] || "") + '">●</span> ' + esc(name) + " v" + esc(s.v) + "</span>" + (s.e ? '<div class="err">' + esc(s.e) + "</div>" : "")).join("");
      return "<tr><td>" + r.machine + '</td><td><a href="https://github.com/' + d.repo + "/actions/runs/" + esc(r.id) + '" target="_blank">' + esc(r.id) + "</a></td><td>" + state + "</td><td>" + (projects || '<span class="muted">none</span>') + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="muted">No machines have checked in</td></tr>');
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`;

// The control plane as one process: SQLite in DATA_DIR, HTTP on 127.0.0.1:PORT (a Cloudflare tunnel in front gives it
// control.<domain>). Settings and secrets come from the environment (see the README).
//   PORT (8920), DATA_DIR (.), DOMAIN, CONTROL_HOST, ZONE, ACCOUNT_ID, POOLS, MAX_SLOTS, FLEET_PASSWORD, JOIN_TOKEN,
//   CF_API_TOKEN (or CF_API_KEY + CF_API_EMAIL), CF_API_BASE (tests), HOT_MS (tests), POLL_S, DNS=off (no DNS changes)
import http from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Control } from "./src/index.js";

const env = process.env;
const port = Number(env.PORT) || 8920;
const dataDir = env.DATA_DIR || ".";
const MAX_BODY = 1_000_000; // bytes; a spec is at most 250 KB, plus JSON quoting
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(`${dataDir}/control.db`);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
// The same shape the code was written against: exec(query, ...args) runs the statement and gives { toArray() }.
const sql = {
  exec(query, ...args) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows };
  },
};

let timer = null;
const control = new Control({
  sql,
  env,
  page: readFileSync(new URL("./src/app.html", import.meta.url), "utf8"),
  alarm(at) {
    clearTimeout(timer);
    timer = setTimeout(() => control.alarm().catch((e) => log(`alarm failed: ${e.message}`)), Math.max(0, at - Date.now()));
  },
  restart() {
    log("restarting on request");
    shutdown(0);
  },
});

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "the request is too big" }));
      }
      chunks.push(c);
    }
    // Behind the tunnel the request was https at the edge (cloudflared says so); the Host header is the public name.
    const host = req.headers.host || env.CONTROL_HOST || `127.0.0.1:${port}`;
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await control.fetch(request);
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": body.length, server: "runner-control" });
    res.end(body);
  } catch (e) {
    log(`request failed: ${e.stack ?? e}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});
server.keepAliveTimeout = 65_000;
server.listen(port, "127.0.0.1", () => log(`control plane listening on 127.0.0.1:${port}, data in ${dataDir}`));

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  server.close(() => {
    db.close();
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 5_000).unref();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(0));

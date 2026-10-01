// Machine and app metrics for the agent: CPU, memory, disk I/O and network I/O.
// Samples the host (/proc) and every container (Docker Engine API over its socket) every 10 seconds, and rolls the
// samples up into one summary per minute (averages, plus the CPU peak). The agent sends the newest sample (for live
// views) and the finished minutes (for history) to the control plane when it checks in.
// No dependencies: Node's built-ins only.
import { readFile } from "node:fs/promises";
import http from "node:http";

const SAMPLE_MS = 10_000;
const KEEP_MINUTES = 30; // minutes held back while the control plane is unreachable
const PEAK = new Set(["cpu"]); // fields whose peak within the minute is kept too, as <field>Max
const SYSTEM_CONTAINERS = new Set(["router", "tunnel"]); // the agent's own containers count as app "_system"

const num = (s) => Number(s) || 0;
const read = (path) => readFile(path, "utf8").catch(() => "");
// Rounded so the payloads stay small: 2 decimals below 100, whole numbers above.
const round = (x) => (!Number.isFinite(x) ? 0 : Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100);

// ---- host ----

// Whole disks only (not partitions, loop or ram devices).
const DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
// The machine's real interfaces: not loopback or docker's bridges and veths.
const SKIP_IF = /^(lo|docker\d*|veth|br-)/;

async function readHost() {
  const [stat, meminfo, diskstats, netdev] = await Promise.all([
    read("/proc/stat"), read("/proc/meminfo"), read("/proc/diskstats"), read("/proc/net/dev"),
  ]);
  // cpu  user nice system idle iowait irq softirq steal
  const cpu = stat.split("\n")[0].trim().split(/\s+/).slice(1, 9).map(num);
  const mem = {};
  for (const line of meminfo.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = num(m[2]) * 1024;
  }
  let rsect = 0, wsect = 0;
  for (const line of diskstats.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (!DISK.test(f[2] ?? "")) continue;
    rsect += num(f[5]);
    wsect += num(f[9]);
  }
  let rx = 0, tx = 0;
  for (const line of netdev.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || SKIP_IF.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(num);
    rx += f[0];
    tx += f[8];
  }
  return {
    at: performance.now(),
    cpuTotal: cpu.reduce((a, b) => a + b, 0),
    cpuIdle: cpu[3] + cpu[4], // idle + iowait
    memTotal: mem.MemTotal ?? 0,
    memAvail: mem.MemAvailable ?? mem.MemFree ?? 0,
    diskRead: rsect * 512,
    diskWrite: wsect * 512,
    rx,
    tx,
  };
}

function hostSample(a, b) {
  const s = (b.at - a.at) / 1000;
  const rate = (k) => Math.max(0, b[k] - a[k]) / s;
  const dt = b.cpuTotal - a.cpuTotal;
  return {
    cpu: dt > 0 ? 100 - (100 * (b.cpuIdle - a.cpuIdle)) / dt : 0,
    memUsed: b.memTotal - b.memAvail,
    memTotal: b.memTotal,
    diskRead: rate("diskRead"),
    diskWrite: rate("diskWrite"),
    netRx: rate("rx"),
    netTx: rate("tx"),
  };
}

// ---- containers (Docker Engine API) ----

function docker(path) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: "/var/run/docker.sock", path, timeout: 8000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

async function readContainers() {
  const list = (await docker("/containers/json")) ?? []; // running containers
  const out = await Promise.all(list.map(async (c) => {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const app = c.Labels?.["com.docker.compose.project"] ?? (SYSTEM_CONTAINERS.has(name) ? "_system" : name);
    const st = await docker(`/containers/${c.Id}/stats?stream=false&one-shot=true`);
    if (!st) return { id: c.Id, app };
    const ms = st.memory_stats ?? {};
    const inactive = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? 0;
    let rx = 0, tx = 0;
    for (const n of Object.values(st.networks ?? {})) {
      rx += n.rx_bytes ?? 0;
      tx += n.tx_bytes ?? 0;
    }
    let br = 0, bw = 0;
    for (const e of st.blkio_stats?.io_service_bytes_recursive ?? []) {
      if (/^read$/i.test(e.op)) br += e.value;
      else if (/^write$/i.test(e.op)) bw += e.value;
    }
    return { id: c.Id, app, cpuNs: st.cpu_stats?.cpu_usage?.total_usage ?? 0, mem: Math.max(0, (ms.usage ?? 0) - inactive), rx, tx, br, bw };
  }));
  return { at: performance.now(), list: out };
}

// Per-app totals between two readings. CPU is in percent of one core, like `docker stats`.
// Containers on host networking share the machine's interfaces, so they show no network of their own.
function appSample(a, b) {
  const s = (b.at - a.at) / 1000;
  const prev = new Map(a.list.map((c) => [c.id, c]));
  const apps = {};
  for (const c of b.list) {
    const x = (apps[c.app] ??= { cpu: 0, mem: 0, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0 });
    x.mem += c.mem ?? 0;
    const p = prev.get(c.id);
    if (p?.cpuNs == null || c.cpuNs == null) continue;
    const d = (k) => Math.max(0, c[k] - p[k]) / s;
    x.cpu += d("cpuNs") / 1e7; // ns per s -> % of a core
    x.netRx += d("rx");
    x.netTx += d("tx");
    x.diskRead += d("br");
    x.diskWrite += d("bw");
  }
  return apps;
}

// ---- the sampler ----

export function startMetrics() {
  let host = null;
  let cont = null;
  let latest = null;
  let minute = null; // { t, h: acc, apps: { app: acc } }, acc = { n, sum, max }
  const done = [];
  let ticking = false;

  const acc = () => ({ n: 0, sum: {}, max: {} });
  const add = (a, sample) => {
    a.n++;
    for (const [k, v] of Object.entries(sample)) {
      a.sum[k] = (a.sum[k] ?? 0) + v;
      if (PEAK.has(k)) a.max[k] = Math.max(a.max[k] ?? -Infinity, v);
    }
  };
  const summarize = (a) => {
    const out = {};
    for (const [k, v] of Object.entries(a.sum)) out[k] = round(v / a.n);
    for (const [k, v] of Object.entries(a.max)) out[`${k}Max`] = round(v);
    return out;
  };
  const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const t = now - (now % 60_000);
      const [h, c] = await Promise.all([readHost(), readContainers()]);
      if (host && cont) {
        const hs = hostSample(host, h);
        const as = appSample(cont, c);
        if (minute?.t !== t) {
          if (minute) {
            const apps = Object.fromEntries(Object.entries(minute.apps).map(([k, a]) => [k, summarize(a)]));
            done.push({ t: minute.t, h: summarize(minute.h), a: apps });
            if (done.length > KEEP_MINUTES) done.splice(0, done.length - KEEP_MINUTES);
          }
          minute = { t, h: acc(), apps: {} };
        }
        add(minute.h, hs);
        for (const [app, x] of Object.entries(as)) add((minute.apps[app] ??= acc()), x);
        latest = { t: now, h: roundAll(hs), a: Object.fromEntries(Object.entries(as).map(([k, v]) => [k, roundAll(v)])) };
      }
      [host, cont] = [h, c];
    } catch (e) {
      console.log(`metrics: ${e.message}`);
    } finally {
      ticking = false;
    }
  }

  tick();
  setInterval(tick, SAMPLE_MS).unref();

  return {
    // What to send with a check-in. Call confirm() once the control plane has taken it.
    payload() {
      return { live: latest, minutes: done.slice() };
    },
    confirm(sent) {
      done.splice(0, sent.minutes.length);
    },
  };
}

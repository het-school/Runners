// Machine and app metrics for the agent. Samples the host (/proc, statfs) and every container (Docker Engine API
// over its socket) every 10 seconds, and rolls the samples up into one summary per minute: the average of
// every field, plus the peak of a few. The agent sends the newest sample (for live views) and the finished
// minutes (for history) to the control plane when it checks in.
// No dependencies: Node's built-ins only.
import { readFile, statfs } from "node:fs/promises";
import http from "node:http";

const SAMPLE_MS = 10_000;
const KEEP_MINUTES = 30; // minutes held back while the control plane is unreachable
// Fields whose peak within the minute is kept too (as <field>Max).
const PEAK = new Set(["cpu", "cpuCoreMax", "load1", "memUsed", "diskUtil", "diskAwait", "psiCpu", "psiMem", "psiIo", "netRx", "netTx"]);
const APP_PEAK = new Set(["cpu", "mem", "lat"]);
const SYSTEM_CONTAINERS = new Set(["router", "tunnel"]); // the agent's own containers count as app "_system"

const num = (s) => Number(s) || 0;
const read = (path) => readFile(path, "utf8").catch(() => "");
// Rounded so the payloads stay small: 2 decimals below 100, whole numbers above.
const round = (x) => (!Number.isFinite(x) ? 0 : Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100);

// ---- host ----

function parseStat(text) {
  const out = { cores: [], ctxt: 0, intr: 0, forks: 0, running: 0, blocked: 0 };
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (/^cpu\d*$/.test(f[0])) {
      // user nice system idle iowait irq softirq steal
      const v = f.slice(1, 9).map(num);
      const c = { user: v[0], nice: v[1], sys: v[2], idle: v[3], iowait: v[4], irq: v[5] + v[6], steal: v[7] };
      c.total = v.reduce((a, b) => a + b, 0);
      if (f[0] === "cpu") out.cpu = c;
      else out.cores.push(c);
    } else if (f[0] === "ctxt") out.ctxt = num(f[1]);
    else if (f[0] === "intr") out.intr = num(f[1]);
    else if (f[0] === "processes") out.forks = num(f[1]);
    else if (f[0] === "procs_running") out.running = num(f[1]);
    else if (f[0] === "procs_blocked") out.blocked = num(f[1]);
  }
  return out;
}

function parseMeminfo(text) {
  const kb = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/);
    if (m) kb[m[1]] = num(m[2]) * 1024;
  }
  return kb;
}

// PSI: cumulative stall time in microseconds, for "some" and "full".
function parsePressure(text) {
  const out = { some: 0, full: 0 };
  for (const line of text.split("\n")) {
    const m = line.match(/^(some|full) .*total=(\d+)/);
    if (m) out[m[1]] = num(m[2]);
  }
  return out;
}

// Whole disks only (not partitions, loop or ram devices).
const DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
function parseDiskstats(text) {
  const t = { reads: 0, rsect: 0, rms: 0, writes: 0, wsect: 0, wms: 0, inflight: 0, ticks: {} };
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (!DISK.test(f[2] ?? "")) continue;
    t.reads += num(f[3]);
    t.rsect += num(f[5]);
    t.rms += num(f[6]);
    t.writes += num(f[7]);
    t.wsect += num(f[9]);
    t.wms += num(f[10]);
    t.inflight += num(f[11]);
    t.ticks[f[2]] = num(f[12]);
  }
  return t;
}

// The machine's real interfaces: not loopback or docker's bridges and veths.
const SKIP_IF = /^(lo|docker\d*|veth|br-|virbr|cni|flannel|tun|wg)/;
function parseNetdev(text) {
  const t = { rx: 0, tx: 0, rxp: 0, txp: 0, errs: 0, drops: 0 };
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || SKIP_IF.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(num);
    t.rx += f[0];
    t.rxp += f[1];
    t.errs += f[2] + f[10];
    t.drops += f[3] + f[11];
    t.tx += f[8];
    t.txp += f[9];
  }
  return t;
}

function parseSnmpTcp(text) {
  const lines = text.split("\n").filter((l) => l.startsWith("Tcp:"));
  if (lines.length < 2) return { estab: 0, out: 0, retrans: 0 };
  const keys = lines[0].split(/\s+/);
  const vals = lines[1].split(/\s+/);
  const get = (k) => num(vals[keys.indexOf(k)]);
  return { estab: get("CurrEstab"), out: get("OutSegs"), retrans: get("RetransSegs") };
}

async function readHost() {
  const [stat, loadavg, meminfo, disk, net, snmp, fileNr, psiCpu, psiMem, psiIo, fs] = await Promise.all([
    read("/proc/stat"), read("/proc/loadavg"), read("/proc/meminfo"), read("/proc/diskstats"), read("/proc/net/dev"),
    read("/proc/net/snmp"), read("/proc/sys/fs/file-nr"), read("/proc/pressure/cpu"), read("/proc/pressure/memory"),
    read("/proc/pressure/io"), statfs("/").catch(() => null),
  ]);
  const la = loadavg.trim().split(/\s+/);
  return {
    at: performance.now(),
    stat: parseStat(stat),
    load: [num(la[0]), num(la[1]), num(la[2])],
    threads: num((la[3] ?? "").split("/")[1]),
    mem: parseMeminfo(meminfo),
    disk: parseDiskstats(disk),
    net: parseNetdev(net),
    tcp: parseSnmpTcp(snmp),
    fds: num(fileNr.trim().split(/\s+/)[0]),
    psi: { cpu: parsePressure(psiCpu), mem: parsePressure(psiMem), io: parsePressure(psiIo) },
    fs,
  };
}

// Rates and percentages between two readings.
function hostSample(a, b) {
  const s = (b.at - a.at) / 1000;
  const rate = (x, y) => Math.max(0, y - x) / s;
  const cpuPct = (ca, cb, key) => (cb.total - ca.total > 0 ? (100 * (cb[key] - ca[key])) / (cb.total - ca.total) : 0);
  const busy = (ca, cb) => 100 - cpuPct(ca, cb, "idle") - cpuPct(ca, cb, "iowait");
  const [ca, cb] = [a.stat.cpu, b.stat.cpu];
  const m = b.mem;
  const memAvail = m.MemAvailable ?? m.MemFree;
  const cached = (m.Cached ?? 0) + (m.SReclaimable ?? 0);
  const dIos = b.disk.reads - a.disk.reads + b.disk.writes - a.disk.writes;
  const util = Math.max(0, ...Object.entries(b.disk.ticks).map(([dev, t]) =>
    a.disk.ticks[dev] == null ? 0 : Math.min(100, (t - a.disk.ticks[dev]) / (s * 10))));
  const psi = (k, kind) => Math.min(100, rate(a.psi[k][kind], b.psi[k][kind]) / 10_000); // µs per s -> %
  const dOut = b.tcp.out - a.tcp.out;
  return {
    cpu: busy(ca, cb),
    cpuUser: cpuPct(ca, cb, "user"),
    cpuNice: cpuPct(ca, cb, "nice"),
    cpuSys: cpuPct(ca, cb, "sys"),
    cpuIowait: cpuPct(ca, cb, "iowait"),
    cpuIrq: cpuPct(ca, cb, "irq"),
    cpuSteal: cpuPct(ca, cb, "steal"),
    cpuCoreMax: Math.max(0, ...b.stat.cores.map((c, i) => (a.stat.cores[i] ? busy(a.stat.cores[i], c) : 0))),
    cores: b.stat.cores.length,
    load1: b.load[0],
    load5: b.load[1],
    load15: b.load[2],
    procsRunning: b.stat.running,
    procsBlocked: b.stat.blocked,
    threads: b.threads,
    ctxt: rate(a.stat.ctxt, b.stat.ctxt),
    intr: rate(a.stat.intr, b.stat.intr),
    forks: rate(a.stat.forks, b.stat.forks),
    memTotal: m.MemTotal ?? 0,
    memUsed: (m.MemTotal ?? 0) - memAvail,
    memAvail,
    memFree: m.MemFree ?? 0,
    memCached: cached,
    memBuffers: m.Buffers ?? 0,
    memShmem: m.Shmem ?? 0,
    memDirty: (m.Dirty ?? 0) + (m.Writeback ?? 0),
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
    psiCpu: psi("cpu", "some"),
    psiMem: psi("mem", "some"),
    psiMemFull: psi("mem", "full"),
    psiIo: psi("io", "some"),
    psiIoFull: psi("io", "full"),
    diskRead: rate(a.disk.rsect, b.disk.rsect) * 512,
    diskWrite: rate(a.disk.wsect, b.disk.wsect) * 512,
    diskReadOps: rate(a.disk.reads, b.disk.reads),
    diskWriteOps: rate(a.disk.writes, b.disk.writes),
    diskUtil: util,
    diskAwait: dIos > 0 ? (b.disk.rms - a.disk.rms + b.disk.wms - a.disk.wms) / dIos : 0,
    diskQueue: b.disk.inflight,
    fsUsed: b.fs ? (b.fs.blocks - b.fs.bfree) * b.fs.bsize : 0,
    fsTotal: b.fs ? b.fs.blocks * b.fs.bsize : 0,
    inodesUsed: b.fs?.files ? (100 * (b.fs.files - b.fs.ffree)) / b.fs.files : 0,
    netRx: rate(a.net.rx, b.net.rx),
    netTx: rate(a.net.tx, b.net.tx),
    netRxPkts: rate(a.net.rxp, b.net.rxp),
    netTxPkts: rate(a.net.txp, b.net.txp),
    netErrs: rate(a.net.errs, b.net.errs),
    netDrops: rate(a.net.drops, b.net.drops),
    tcpEstab: b.tcp.estab,
    tcpRetrans: dOut > 0 ? (100 * (b.tcp.retrans - a.tcp.retrans)) / dOut : 0,
    fds: b.fds,
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

const restartCounts = new Map(); // container id -> RestartCount, looked up once a minute

async function readContainers(withRestarts) {
  const list = (await docker("/containers/json?all=1")) ?? [];
  const out = await Promise.all(list.map(async (c) => {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const app = c.Labels?.["com.docker.compose.project"] ?? (SYSTEM_CONTAINERS.has(name) ? "_system" : name);
    const base = { id: c.Id, app, running: c.State === "running", unhealthy: /\(unhealthy\)/.test(c.Status ?? "") };
    if (withRestarts || !restartCounts.has(c.Id)) {
      const info = await docker(`/containers/${c.Id}/json`);
      if (info) restartCounts.set(c.Id, info.RestartCount ?? 0);
    }
    base.restarts = restartCounts.get(c.Id) ?? 0;
    if (!base.running) return base;
    const st = await docker(`/containers/${c.Id}/stats?stream=false&one-shot=true`);
    if (!st) return base;
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
    return {
      ...base,
      cpuNs: st.cpu_stats?.cpu_usage?.total_usage ?? 0,
      mem: Math.max(0, (ms.usage ?? 0) - inactive),
      rx, tx, br, bw,
      hostNet: !st.networks, // network_mode: host shares the machine's interfaces, so it has no counters of its own
      pids: st.pids_stats?.current ?? 0,
    };
  }));
  for (const id of restartCounts.keys()) if (!list.some((c) => c.Id === id)) restartCounts.delete(id);
  return { at: performance.now(), list: out };
}

// Per-app totals between two readings. CPU is in percent of one core, like `docker stats`.
function appSample(a, b, probes) {
  const s = (b.at - a.at) / 1000;
  const prev = new Map(a.list.map((c) => [c.id, c]));
  const apps = {};
  for (const c of b.list) {
    const x = (apps[c.app] ??= { cpu: 0, mem: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 0, containers: 0, running: 0, unhealthy: 0, restarts: 0 });
    x.containers++;
    x.restarts += c.restarts;
    if (!c.running) continue;
    x.running++;
    x.unhealthy += c.unhealthy ? 1 : 0;
    x.mem += c.mem ?? 0;
    x.pids += c.pids ?? 0;
    const p = prev.get(c.id);
    if (!p || p.cpuNs == null || c.cpuNs == null) continue;
    const d = (k) => Math.max(0, c[k] - p[k]) / s;
    x.cpu += d("cpuNs") / 1e7; // ns per s -> % of a core
    if (!c.hostNet) {
      x.netRx += d("rx");
      x.netTx += d("tx");
    }
    x.blkRead += d("br");
    x.blkWrite += d("bw");
  }
  for (const [app, p] of Object.entries(probes)) {
    const x = (apps[app] ??= { cpu: 0, mem: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 0, containers: 0, running: 0, unhealthy: 0, restarts: 0 });
    Object.assign(x, p);
  }
  return apps;
}

// ---- the sampler ----

export function startMetrics({ probe }) {
  let host = null;
  let cont = null;
  let latest = null;
  let minute = null; // { t, n, sum, max, apps: { app: { n, sum, max } } }
  const done = [];
  let ticking = false;

  const add = (acc, sample, peak) => {
    acc.n++;
    for (const [k, v] of Object.entries(sample)) {
      acc.sum[k] = (acc.sum[k] ?? 0) + v;
      if (peak.has(k)) acc.max[k] = Math.max(acc.max[k] ?? -Infinity, v);
    }
  };
  const summarize = (acc) => {
    const out = {};
    for (const [k, v] of Object.entries(acc.sum)) out[k] = round(v / acc.n);
    for (const [k, v] of Object.entries(acc.max)) out[`${k}Max`] = round(v);
    return out;
  };
  const close = () => {
    if (!minute) return;
    const apps = {};
    for (const [app, acc] of Object.entries(minute.apps)) apps[app] = summarize(acc);
    done.push({ t: minute.t, n: minute.n, h: summarize(minute), a: apps });
    if (done.length > KEEP_MINUTES) done.splice(0, done.length - KEEP_MINUTES);
    minute = null;
  };

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const t = now - (now % 60_000);
      const newMinute = !minute || minute.t !== t;
      const [h, c, probes] = await Promise.all([readHost(), readContainers(newMinute), probe()]);
      if (host && cont) {
        const hs = hostSample(host, h);
        const as = appSample(cont, c, probes);
        if (newMinute) {
          close();
          minute = { t, n: 0, sum: {}, max: {}, apps: {} };
        }
        add(minute, hs, PEAK);
        for (const [app, x] of Object.entries(as)) add((minute.apps[app] ??= { n: 0, sum: {}, max: {} }), x, APP_PEAK);
        const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
        latest = { t: now, h: r(hs), a: Object.fromEntries(Object.entries(as).map(([k, v]) => [k, r(v)])) };
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

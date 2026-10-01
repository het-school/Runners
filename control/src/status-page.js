// Public, read-only status page; it polls /api/status.
export const STATUS_PAGE = `<!doctype html>
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
  <h1>Runner <a href="/metrics" style="font-size:14px;font-weight:500;margin-left:8px">Metrics →</a></h1>
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
  document.getElementById("sub").textContent = up.size + " machines up" + (d.dnsError ? " · DNS: " + d.dnsError : "");
  document.getElementById("projects").innerHTML = "<tr><th>Project</th><th>Version</th><th>Replicas</th><th>State</th><th>Open</th></tr>" +
    (d.projects.map((p) => {
      const state = p.state === "live" ? '<span class="ok">live</span>'
        : p.state === "halted" ? '<span class="bad">halted, every machine is back on v' + esc(p.stable ?? "-") + '</span><div class="err">' + esc(p.halted) + "</div>"
        : '<span class="warn">deploying</span>';
      const links = p.port ? '<a href="https://' + p.name + "." + d.domain + '/" target="_blank"><b>' + esc(p.name) + "." + d.domain + "</b></a> " +
        (p.replicas === "all" ? d.slots : p.placed.map((x) => x.machine)).map((n) => '<a href="https://' + p.name + "-" + n + "." + d.domain + '/" target="_blank">' + n + "</a>").join("") : '<span class="muted">no port</span>';
      return "<tr><td><b>" + esc(p.name) + "</b></td><td>v" + p.version + (p.stable && p.stable !== p.version ? ' <span class="muted">(v' + p.stable + " elsewhere)</span>" : "") +
        "</td><td>" + (p.replicas === "all" ? "every machine" : p.placed.length + " of " + p.replicas) + (p.stateful ? ' <span class="muted">stateful</span>' : "") + "</td><td>" + state + '</td><td class="links">' + links + "</td></tr>";
    }).join("") || '<tr><td colspan="5" class="muted">No projects yet</td></tr>');
  document.getElementById("machines").innerHTML = "<tr><th>Machine</th><th>Run or host</th><th>State</th><th>Projects</th></tr>" +
    (d.runs.map((r) => {
      const state = !r.live ? '<span class="muted">gone (seen ' + ago(d.now - r.seen) + " ago)</span>"
        : r.retiring ? '<span class="muted">leaving, replaced</span>'
        : r.handover ? '<span class="warn">starting its replacement</span>'
        : r.ready ? '<span class="ok">online</span> <span class="muted">' + ago(d.now - r.started) + "</span>"
        : '<span class="warn">starting up</span>';
      const projects = Object.entries(r.projects).map(([name, s]) =>
        '<span class="chip"><span class="' + (STATE[s.s] || "") + '">●</span> ' + esc(name) + " v" + esc(s.v) + "</span>" + (s.e ? '<div class="err">' + esc(s.e) + "</div>" : "")).join("");
      const run = r.kind === "host" ? esc(r.label || "host") + ' <span class="muted">(own host)</span>'
        : '<a href="https://github.com/' + d.repo + "/actions/runs/" + esc(r.id) + '" target="_blank">' + esc(r.id) + "</a>";
      return "<tr><td>" + r.machine + "</td><td>" + run + "</td><td>" + state + "</td><td>" + (projects || '<span class="muted">none</span>') + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="muted">No machines have checked in</td></tr>');
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`;

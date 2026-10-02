import http from "node:http";
const log = [];
let n = 0;
http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const u = new URL(req.url, "http://x"); log.push(`${req.method} ${u.pathname}${u.search} ${body.slice(0,4000)}`);
    console.log(log.at(-1));
    let result = [];
    if (u.pathname.endsWith("/cfd_tunnel") && req.method === "POST") result = { id: `tun-${JSON.parse(body).name}` };
    else if (u.pathname.endsWith("/token")) result = `token-for-${u.pathname.split("/").at(-2)}`;
    else if (u.pathname.includes("/dns_records") && req.method === "GET") result = [{ id: "x1", type: "A", name: "control.billybishop4-workers.xyz", content: "1.1.1.1" }, { id: "x2", type: "CNAME", name: "iptv.billybishop4-workers.xyz", content: "foo" }];
    else if (req.method !== "GET") result = {};
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, errors: [], result, result_info: { total_pages: 1 } }));
  });
}).listen(8790);

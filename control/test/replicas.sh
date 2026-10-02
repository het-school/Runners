#!/bin/bash
# Replica numbers: replicas are numbered 1..N, keep their number when they move or their machine goes away, and the
# highest go when N is lowered. The Worker's routes and the DNS names follow the numbers, not the machines.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var NODE_TOKEN:node --var 'POOLS:{"github":4}' --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
A='authorization: Bearer adm'
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" -H content-type:application/json -d "$2" | jq -c '{name, replicas, error}'; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"github\",\"want\":$2}" >/dev/null; }
# A machine checks in like an agent: it reports web healthy from the check-in after it's told to run it.
declare -A REPORT
LOAD=([1]="50 50" [2]="10 20" [3]="30 40" [4]="20 30" [5]="5 10")
MACHINES="1 2 3 4"
sync() { # machine [leaving]
  local m=$1 l=(${LOAD[$1]}) res
  res=$(curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$m,\"run\":\"r$m\",\"agent\":\"gh-r$m\",\"pool\":\"github\",\"started\":$START,\"ready\":true,\"status\":${REPORT[$m]:-{\}},\"leaving\":${2:-false},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":${l[0]},\"memUsed\":${l[1]},\"memTotal\":100},\"a\":{}}}}")
  if echo "$res" | jq -e '.desired.web' >/dev/null; then REPORT[$m]='{"web":{"v":1,"s":"healthy"}}'; else REPORT[$m]='{}'; fi
}
tick() { for m in $MACHINES; do sync $m; done; }
show() { curl -s $B/api/status | jq -c '.projects[] | {name, replicas, placed:[.placed[] | "r\(.replica)@m\(.machine)\(if .leaving then " (leaving→m\(.leaving.to))" else "" end)"]}'; }
routes() { echo "   routes: $(curl -s $B/internal/routes | jq -c .replicas)"; }
machineOf() { curl -s $B/api/status | jq -r ".projects[0].placed[] | select(.replica == $1 and (.leaving | not)) | .machine"; }

join a 1; join b 2; join c 3; join d 4
echo "== 2 replicas:"; put web '{"port":8080,"dockerfile":"FROM x","replicas":2}'; tick; tick; tick; show; routes
echo "== up to 3: replica 3 is added, 1 and 2 stay put:"; put web '{"port":8080,"dockerfile":"FROM x","replicas":3}'; tick; tick; show; routes
echo "== down to 1: the highest numbers go:"; put web '{"port":8080,"dockerfile":"FROM x","replicas":1}'; tick; tick; show; routes
m=$(machineOf 1)
echo "== move replica 1 off machine $m: the new copy is replica 1 too:"; curl -s -X POST "$B/api/projects/web/move?from=$m" -H "$A" >/dev/null; show
echo "-- the new copy is starting: replica 1's URL stays on the old one:"; tick; routes
echo "-- the new copy reports healthy: the old one is dropped and the URL follows:"; tick; show; routes
m=$(machineOf 1)
echo "== machine $m leaves for good and machine 5 joins the pool: replica 1 goes to the best machine, same number:"
join e 5; MACHINES=$(echo 1 2 3 4 5 | tr ' ' '\n' | grep -vx "$m" | tr '\n' ' '); sync $m true; tick; tick; show; routes
echo "== names that end like replica or machine URLs are refused, and replicas is only a number:"; put web-2 '{"port":8080,"dockerfile":"FROM x"}'; put web-m3 '{"port":8080,"dockerfile":"FROM x"}'; put web '{"port":8080,"dockerfile":"FROM x","replicas":"all"}'
echo "== up to 2 again; DNS: replica names are Worker placeholders and routes, machine names are web-m<n>:"; put web '{"port":8080,"dockerfile":"FROM x","replicas":2}'; tick; sleep 4
grep "^POST .*dns_records/batch" /tmp/runner-test-mock.log | tail -1 | jq -Rr 'sub("^POST [^ ]* "; "") | fromjson | to_entries[] | "   \(.key): \([.value[] | "\(.type) \(.name | sub("\\.billybishop4-workers\\.xyz"; ""))"] | join(", "))"'
echo "   routes added: $(grep "^POST .*workers/routes" /tmp/runner-test-mock.log | tail -3 | grep -o '"pattern":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
grep -i "error\|exception" /tmp/runner-test-dev.log | grep -v "Cloudflare API" | head -5
. "$HERE/stop.sh"

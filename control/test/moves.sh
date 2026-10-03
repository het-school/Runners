#!/bin/bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var NODE_TOKEN:node --var 'POOLS:{"main":3}' --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
A='authorization: Bearer adm'
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" -H content-type:application/json -d "$2" >/dev/null; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}" >/dev/null; }
# sync machine run cpu mem [statusjson]
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$1,\"run\":\"$2\",\"agent\":\"agent-$2\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":${5:-{\}},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":$3,\"memUsed\":$4,\"memTotal\":100},\"a\":{}}}}" | jq -c '{m:'$1', desired:(.desired|keys)}'; }
show() { curl -s $B/api/status | jq -c '.projects[] | {name, staying, placed:[.placed[] | "r\(.replica)@\(.machine)\(if .leaving then " (leaving→\(.leaving.to))" else "" end)"]}'; }
put web '{"port":8080,"dockerfile":"FROM x","replicas":1}'
join a 1; join b 2; join c 3
sync 1 r1 80 80 >/dev/null; sync 2 r2 5 20 >/dev/null; sync 3 r3 30 40 >/dev/null
echo "== placed:"; show
echo "== move web off machine 2 (auto destination):"; curl -s -X POST "$B/api/projects/web/move?from=2" -H "$A" | jq -c '[.placed[] | {machine, reason, leaving}]'
echo "-- both machines should want it now:"; sync 2 r2 5 20; sync 3 r3 30 40
echo "-- new copy (m3) reports healthy -> old copy dropped:"; sync 3 r3 30 40 '{"web":{"v":1,"s":"healthy"}}' >/dev/null; sync 2 r2 5 20; show
echo "== move again to a named machine (1):"; curl -s -X POST "$B/api/projects/web/move?from=3&to=1" -H "$A" | jq -c '[.placed[] | {machine, leaving}]'
echo "-- move while moving is refused:"; curl -s -X POST "$B/api/projects/web/move?from=3" -H "$A" | jq -c .
echo "== evict machine 1 (web's new copy is there, not yet healthy; still moves):"; curl -s -X POST "$B/api/machines/1/evict" -H "$A" | jq -c .
show
echo "== portal can't move:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/admin/api/machines/1/evict" -H 'origin: http://localhost:8911'
. "$HERE/stop.sh"

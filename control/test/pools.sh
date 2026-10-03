#!/bin/bash
# Pools: members that can start machines (starts: true, or agents from before the field) are asked to start missing
# peers; members that can't aren't, and whatever watches their pool gets the slots from /api/claim instead.
# Whatever runs a machine can drain it by its agent's ID, and the machine is then asked to hand over.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var NODE_TOKEN:node --var 'POOLS:{}' --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
N='authorization: Bearer node'
join() { curl -s -X POST $B/api/join -H "$N" -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"$2\",\"want\":$3}" | jq -c '{machine, error}'; }
sync() { # agent pool size machine [extra JSON fields]
  curl -s -X POST $B/api/sync -H "$N" -H content-type:application/json \
    -d "{\"machine\":$4,\"run\":\"$1-$START\",\"agent\":\"$1\",\"pool\":\"$2\",\"poolSize\":$3,\"started\":$START,\"ready\":true,\"status\":{}${5:+,$5}}" |
    jq -c '{start, handover, retire, error}'
}

echo "== pool a (size 3), its member can start machines: asked to start the 2 missing"
join a1 a 1; sync a1 a 3 1 '"starts":true'
echo "== pool b (size 2), its member can't: not asked"
join b1 b 4; sync b1 b 2 4 '"starts":false'
echo "== whatever watches pool b claims the missing one"
curl -s -X POST "$B/api/claim?pool=b" -H "$N" | jq -c .
echo "== asked again: the claimed slot is held while that machine starts, so nothing more"
curl -s -X POST "$B/api/claim?pool=b" -H "$N" | jq -c .
echo "== pool c (size 2), an agent from before the starts field: asked, as before"
join c1 c 6; sync c1 c 2 6
echo "== drain a1 by its agent ID; its next check-in is asked to hand over"
curl -s -X POST $B/api/drain -H "$N" -H content-type:application/json -d '{"agent":"a1"}' | jq -c .
sync a1 a 3 1 '"starts":true'
echo "== drain an agent that isn't there"
curl -s -X POST $B/api/drain -H "$N" -H content-type:application/json -d '{"agent":"nope"}' | jq -c .
echo "== pools on the status page"
curl -s $B/api/status | jq -c .pools

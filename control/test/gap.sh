#!/bin/bash
# A gap in check-ins (the control plane itself was unreachable, say its tunnel dropped) mustn't make the first machine to
# come back the only live one and give it every copy. After such a gap nothing counts as gone for a while, as after a
# restart. POLL_S=2 fixes the poll so a gap is a few seconds here.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
. "$HERE/start.sh" ADMIN_PASSWORD=adm JOIN_TOKEN=node 'POOLS={"main":3}' POLL_S=2
B=localhost:8911; START=$(date +%s%3N)
J='content-type: application/json'
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H "$J" -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}" >/dev/null; }
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H "$J" -d "{\"machine\":$1,\"run\":\"r$1\",\"agent\":\"agent-r$1\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":${REPORT[$1]:-{\}},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":10,\"memUsed\":20,\"memTotal\":100},\"a\":{}}}}" | jq -c '[.desired | keys[]]' ; }
declare -A REPORT
tick() { for m in 1 2 3; do d=$(sync $m); if echo "$d" | jq -e 'index("web")' >/dev/null; then REPORT[$m]='{"web":{"v":1,"s":"healthy"}}'; else REPORT[$m]='{}'; fi; done; }
show() { curl -s $B/api/status | jq -c '.projects[] | {name, placed: [.placed[] | "r\(.replica)@m\(.machine)"]}'; }
join a 1; join b 2; join c 3; tick
curl -s -X PUT $B/api/projects/web -H "$J" -d '{"port":8080,"dockerfile":"FROM x","replicas":3}' >/dev/null
tick; tick; echo "== 3 replicas on 3 machines:"; show
echo "== nobody checks in for 14s (longer than the 12.5s liveness window), then only machine 1 does, twice:"
sleep 14; sync 1 >/dev/null; sleep 1; sync 1 >/dev/null; show
echo "   (every copy still where it was: a gap isn't machines dying)"
echo "== the others come back: nothing moved"; tick; tick; show
echo "== a machine that really goes away after the grace period would still be replaced (grace is ${SETTLE_MS:-5 min}, not tested here)"
grep -i "error\|exception" /tmp/runner-test-dev.log | grep -v "Cloudflare API" | head -5
grep -i "gap\|unreachable" /tmp/runner-test-dev.log | head -3
. "$HERE/stop.sh"

#!/bin/bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
. "$HERE/start.sh" ADMIN_PASSWORD=adm JOIN_TOKEN=node 'POOLS={"main":3}'
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
put() { curl -s -X PUT $B/api/projects/$1 -H 'x-admin-password: adm' -H content-type:application/json -d "$2" >/dev/null; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}" >/dev/null; }
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$1,\"run\":\"$2\",\"agent\":\"agent-$2\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":{},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":$3,\"memUsed\":$4,\"memTotal\":100},\"a\":{}}}}" | jq -c '{m:'$1', desired:(.desired|keys)}'; curl -s $B/api/status | jq -c '[.projects[] | {name, placed:[.placed[] | "\(.machine): \(.reason)"]}]'; }
put web '{"port":8080,"dockerfile":"FROM x","replicas":2}'; put one '{"port":8082,"dockerfile":"FROM x"}'
join a 1; join b 2; join c 3
sync 1 r1 80 80; sync 2 r2 5 20; sync 3 r3 30 40; sync 1 r1 80 80
grep -i "error\|exception" /tmp/runner-test-dev.log | head -5
. "$HERE/stop.sh"

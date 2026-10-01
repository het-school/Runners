#!/bin/bash
cd "$(dirname "$0")/.."
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done
rm -rf /tmp/runner-test-state
(node "$(dirname "$0")/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var NODE_TOKEN:node --var MACHINES:3 --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
put() { curl -s -X PUT $B/api/projects/$1 -H 'authorization: Bearer adm' -H content-type:application/json -d "$2" >/dev/null; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"kind\":\"github\",\"want\":$2}" >/dev/null; }
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$1,\"run\":\"$2\",\"agent\":\"gh-$2\",\"kind\":\"github\",\"started\":$START,\"ready\":true,\"status\":{},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":$3,\"memUsed\":$4,\"memTotal\":100},\"a\":{}}}}" | jq -c '{m:'$1', desired:(.desired|keys)}'; curl -s $B/api/status | jq -c '[.projects[] | {name, placed:[.placed[] | "\(.machine): \(.reason)"]}]'; }
put web '{"port":8080,"dockerfile":"FROM x","replicas":2}'; put one '{"port":8082,"dockerfile":"FROM x"}'
join a 1; join b 2; join c 3
sync 1 r1 80 80; sync 2 r2 5 20; sync 3 r3 30 40; sync 1 r1 80 80
grep -i "error\|exception" /tmp/runner-test-dev.log | head -5
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done

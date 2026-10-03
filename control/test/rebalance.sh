#!/bin/bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var FLEET_PASSWORD:adm --var JOIN_TOKEN:node --var 'POOLS:{"main":3}' --var HOT_MS:20000 --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(( $(date +%s%3N) - 6*60*1000 ))   # machines "up" 6 min, so they're settled
A='x-fleet-password: adm'
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" -H content-type:application/json -d "$2" >/dev/null; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}" >/dev/null; }
# sync machine cpu mem statusjson appsjson
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$1,\"run\":\"r$1\",\"agent\":\"agent-r$1\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":${4:-{\}},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":$2,\"memUsed\":$3,\"memTotal\":100},\"a\":${5:-{\}}}}}" >/dev/null; }
show() { curl -s $B/api/status | jq -c '{placed:[.projects[] | "\(.name)→\([.placed[] | "\(.machine)\(if .leaving then "(leaving)" else "" end)"]|join(","))"], hot:.rebalance.hot, log:[.rebalance.log[].text]}'; }
put a '{"port":8001,"dockerfile":"FROM x"}'; put b '{"port":8002,"dockerfile":"FROM x"}'; put c '{"port":8003,"dockerfile":"FROM x"}'
join a 1; join b 2; join c 3
echo "== all quiet, m1 quietest: placements spread by load"
sync 1 5 10; sync 2 20 30; sync 3 40 50; sync 1 5 10
show
H='{"a":{"v":1,"s":"healthy"},"b":{"v":1,"s":"healthy"},"c":{"v":1,"s":"healthy"}}'
echo "== machine 1 goes hot (cpu 95) for 20s; a is its heaviest app"
for i in 1 2 3 4 5; do sync 1 95 60 "$H" '{"a":{"cpu":70,"mem":20},"b":{"cpu":5,"mem":5}}'; sync 2 20 30 "$H"; sync 3 40 50 "$H"; sleep 7; done
sync 1 95 60 "$H" '{"a":{"cpu":70,"mem":20},"b":{"cpu":5,"mem":5}}'
show
echo "== destination reports a healthy -> old copy dropped; a second move must wait for the cooldown"
sync 2 20 30 '{"a":{"v":1,"s":"healthy"}}'; sync 1 95 60 "$H"; sync 3 40 50 "$H"; sleep 31; sync 1 95 60 "$H"
show
echo "== rebalance off:"; curl -s -X PUT $B/api/settings -H "$A" -H content-type:application/json -d '{"rebalance":false}'; echo
curl -s $B/api/status | jq -c '.rebalance.on'
. "$HERE/stop.sh"

#!/bin/bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var NODE_TOKEN:node --var 'POOLS:{"github":2}' \
  --var FS_BUCKET:runner-fs --var FS_ENDPOINT:https://acct.r2.example --var FS_ACCESS_KEY_ID:AK --var FS_SECRET_ACCESS_KEY:SK --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 40); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; A='authorization: Bearer adm'; START=$(( $(date +%s%3N) - 6*60*1000 ))
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" -H content-type:application/json -d "$2"; echo; }
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H content-type:application/json -d "{\"agent\":\"$1\",\"pool\":\"github\",\"want\":$2}" | jq -c 'if .storage then {machine, storage: (.storage|keys)} else . end'; }
# sync machine run started status -> prints desired summary
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$1,\"run\":\"$2\",\"agent\":\"gh-$2\",\"pool\":\"github\",\"started\":$3,\"ready\":true,\"status\":$4,\"storage\":\"ok\",\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":5,\"memUsed\":10,\"memTotal\":100},\"a\":{}}}}" | jq -c '{run:"'$2'", retire, desired: (.desired | to_entries | map({(.key): (if .value.prepare then "prepare" else (.value.storage.prefix // "stateless") end)}) | add), storage: (.storage.bucket)}'; }
echo "== validation:"
put bad1 '{"dockerfile":"FROM x","state":"stateful"}' | jq -r .error
put bad2 '{"dockerfile":"FROM x","state":"stateful","data":"/data","storage":600}' | jq -r .error
put bad3 '{"dockerfile":"FROM x","data":"/data"}' | jq -r .error
put bad4 '{"port":1,"state":"stateful","data":"/data","compose":"services:\n  a:\n    image: x\n    volumes: [\"./x:/data\"]\n"}' | jq -r .error
echo "== dockerfile-only stateful (storage 0.25G -> 256):"
put notes '{"port":8080,"dockerfile":"FROM x","state":"stateful","data":"/data/","storage":"0.25G"}' | jq -c '{name, state, data, storage, replicas}'
curl -s $B/api/projects/notes -H "$A" | jq -r '.compose'
echo "== compose x-runner stateful, replicas all:"
put every '{"compose":"x-runner:\n  port: 9000\n  state: stateful\n  data: /var/lib/app\n  storage: 50M\n  replicas: all\nservices:\n  web:\n    image: nginx\n"}' | jq -c '{name, state, data, storage, replicas}'
echo "== 2 machines; placement of notes gets ordinal r0; rendered compose per machine:"
join a 1; join b 2
sync 1 r1 $START '{}'; sync 2 r2 $START '{}'
curl -s $B/api/status | jq -c '.projects[] | {name, placed:[.placed[] | "\(.machine):\(.replica)"]}'
M=$(curl -s $B/api/status | jq -r '.projects[] | select(.name=="notes") | .placed[0].machine'); O=$([ "$M" = 1 ] && echo 2 || echo 1)
sync $M r$M $START '{}' | jq -c .desired
curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H content-type:application/json -d "{\"machine\":$M,\"run\":\"r$M\",\"agent\":\"gh-r$M\",\"pool\":\"github\",\"started\":$START,\"ready\":true,\"status\":{}}" | jq -r '.desired.notes.compose, .desired.every.compose' | grep -E "x-runner|source|target|replicas" 
echo "== handover gating: newer run r${M}b on machine $M while r$M still reports notes -> notes marked prepare; after r$M stops it -> active"
H='{"notes":{"v":1,"s":"healthy"},"every":{"v":1,"s":"healthy"}}'
sync $M r$M $START "$H" >/dev/null
NEW=$(date +%s%3N); sync $M r${M}b $NEW '{}'
sync $M r$M $START '{"every":{"v":1,"s":"healthy"}}' >/dev/null
sync $M r${M}b $NEW '{}'
echo "== stop-first move of notes $M -> $O:"
sync $M r$M $START "$H" >/dev/null   # old run reports it again (simulate: it's still running on the old run)
curl -s -X POST "$B/api/projects/notes/move?from=$M&to=$O" -H "$A" | jq -c '[.placed[] | {machine, replica, leaving}]'
echo "-- machine $M desired now excludes notes (stop first); $O already has it, marked prepare:"
sync $M r$M $START "$H" | jq -c .desired; sync $O r$O $START '{}' | jq -c .desired
echo "-- machine $M reports it stopped -> new copy placed on $O with the same ordinal:"
sync $M r$M $START '{"every":{"v":1,"s":"healthy"}}' >/dev/null; sync $O r$O $START '{}' | jq -c .desired
curl -s $B/api/status | jq -c '.projects[] | select(.name=="notes") | [.placed[] | {machine, replica, leaving: (.leaving != null)}]'
echo "-- $O reports healthy -> old placement gone:"
sync $O r$O $START '{"notes":{"v":1,"s":"healthy"},"every":{"v":1,"s":"healthy"}}' >/dev/null
curl -s $B/api/status | jq -c '.projects[] | select(.name=="notes") | [.placed[] | {machine, replica}]'
echo "== wipe guards:"; curl -s -X POST "$B/api/projects/notes/wipe?replica=r0" -H "$A" | jq -r .error
curl -s -X POST $B/api/projects/notes/disable -H "$A" >/dev/null; curl -s -X POST "$B/api/projects/notes/wipe?replica=r0" -H "$A" | jq -r .error
grep -iE "error|exception|TypeError" /tmp/runner-test-dev.log | grep -v "Workers runtime" | head -5
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done

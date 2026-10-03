#!/bin/bash
# More replicas than machines: every machine gets a copy first, then the least busy machines get a second one, with
# its published ports moved aside; the Worker's routes know both; lowering the count drops the extra copies; a copy
# can be moved by replica number onto a machine that already has one; an app that can't run twice on a machine waits
# and says why. Each line says ok, or WRONG.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
. "$HERE/start.sh" ADMIN_PASSWORD=adm JOIN_TOKEN=node 'POOLS={"main":5}'
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
A='x-admin-password: adm'
J=(-H content-type:application/json)
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  WRONG $1: wanted [$2], got [$3]"; fi; }
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" "${J[@]}" -d "$2" > /dev/null; }
join() { curl -s -o /dev/null -X POST $B/api/join -H 'authorization: Bearer node' "${J[@]}" -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}"; }
declare -A LOAD=([1]="80 80" [2]="10 20" [3]="30 40" [4]="20 30" [5]="5 10")
declare -A REPORT
sync() { # machine: reports every copy it was told to run as healthy from the next check-in on
  local m=$1 l=(${LOAD[$1]}) res
  res=$(curl -s -X POST $B/api/sync -H 'authorization: Bearer node' "${J[@]}" -d "{\"machine\":$m,\"run\":\"r$m\",\"agent\":\"agent-r$m\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":${REPORT[$m]:-{\}},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":${l[0]},\"memUsed\":${l[1]},\"memTotal\":100},\"a\":{}}}}")
  REPORT[$m]=$(echo "$res" | jq -c '[.desired | to_entries[] | {key, value: {v: .value.v, s: "healthy"}}] | from_entries')
  echo "$res"
}
tick() { for m in 1 2 3 4 5; do sync $m > /dev/null; done; }
copies() { curl -s $B/api/status | jq -r ".projects[] | select(.name == \"$1\") | [.placed[] | select(.leaving | not) | \"\(.replica)@\(.machine)\(if .moved then \"*\" else \"\" end)\"] | sort | join(\" \")"; }
onMachine() { curl -s $B/api/status | jq -r ".projects[] | select(.name == \"$1\") | [.placed[] | select(.machine == $2 and (.leaving | not)) | .replica] | sort | join(\",\")"; }
blocked() { curl -s $B/api/status | jq -r ".projects[] | select(.name == \"$1\") | .blocked // \"none\""; }

for m in 1 2 3 4 5; do join a$m $m; done
echo "== web: 7 replicas on 5 machines (loads: 1 busiest, 5 and 2 quietest)"
put web '{"port":8080,"compose":"services:\n  w:\n    image: x\n    ports: [\"8080:80\"]\n","replicas":7}'
tick; tick; tick
check "every machine has one, machines 5 and 2 have two" "1@5 2@2 3@4 4@3 5@1 6@5* 7@2*" "$(copies web)"
d=$(sync 5)
check "machine 5 is told two copies: web and web-r6" "web web-r6" "$(echo "$d" | jq -r '.desired | keys | sort | join(" ")')"
check "the second copy says which app and replica it is" "web 6" "$(echo "$d" | jq -r '.desired["web-r6"] | "\(.app) \(.replica)"')"
check "its published port is moved out of the first copy's way" 35994 "$(echo "$d" | jq -r '.desired["web-r6"].port')"
check "and so is the compose file's" true "$(echo "$d" | jq -r '.desired["web-r6"].compose | contains("35994:80")')"
check "the first copy's compose is untouched" true "$(echo "$d" | jq -r '.desired.web.compose | contains("\"8080:80\"")')"
check "the second copy's reason says so" true "$(curl -s $B/api/status | jq '.projects[0].placed[] | select(.replica == 6) | .reason | startswith("copy 2 on this machine")')"
echo "== routes: replica 6's URL goes to machine 5, like replica 1's"
tick
check "the names of replicas 1 and 6 point at machine 5's tunnel" "tun-runner-5 tun-runner-5" "$(curl -s $B/internal/dns | jq -r '.names | "\(.["web-1"]) \(.["web-6"])"')"
echo "== move replica 6 off machine 5 onto machine 3 (which has replica 4): a second copy there"
curl -s -X POST "$B/api/projects/web/move?from=5&replica=6&to=3" -H "$A" > /dev/null
check "replica 6 is on 3 now, with moved ports, while the old copy leaves" "6@3*" "$(curl -s $B/api/status | jq -r '.projects[0].placed[] | select(.replica == 6 and (.leaving | not)) | "\(.replica)@\(.machine)\(if .moved then "*" else "" end)"')"
tick; tick
check "the old copy is dropped once machine 3 reports it healthy" "4,6" "$(onMachine web 3)"
check "machine 5 runs only replica 1 now" "1" "$(onMachine web 5)"
echo "== 'move apps off' machine 2 moves both of its copies, by replica"
check "evict names both copies" '["web (replica 7)","web (replica 2)"]' "$(curl -s -X POST $B/api/machines/2/evict -H "$A" | jq -c '.moved | sort | reverse')"
tick; tick
check "machine 2 is empty" "" "$(onMachine web 2)"
echo "== down to 5 replicas: the extra copies go"
put web '{"replicas":5}'
tick
check "5 copies, none doubled" "1 2 3 4 5" "$(copies web | sed -E 's/@[0-9]+\*?//g')"
echo "== an app on the machine's own network can't run twice on a machine: the 6th replica waits and says why"
put hostnet '{"port":9100,"compose":"services:\n  h:\n    image: y\n    network_mode: host\n","replicas":6}'
tick; tick
check "5 copies placed" 5 "$(copies hostnet | wc -w)"
check "why the 6th waits" "every machine already runs it, and it can't run twice on one machine (services.h.network_mode: host)" "$(blocked hostnet)"
check "moving it onto a machine that has it is refused" 409 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/projects/hostnet/move?from=1&to=2" -H "$A")"
grep -i "error\|exception" /tmp/runner-test-dev.log | grep -v "Cloudflare API" | head -5
. "$HERE/stop.sh"

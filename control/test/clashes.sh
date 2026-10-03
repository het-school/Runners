#!/bin/bash
# Placement keeps apps that publish the same host port (or use the same container name) off one machine; a chosen move
# destination with a clash is refused; a PUT with only a replica count keeps the latest files; the compose file made
# for a Dockerfile-only app follows a new port; a port that disagrees with x-runner.port is refused; and the join token
# alone can't take a live machine's slot (a replacement for a handover can). Each line says ok, or WRONG.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
. "$HERE/start.sh" FLEET_PASSWORD=adm JOIN_TOKEN=node 'POOLS={"main":3}'
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
B=localhost:8911; START=$(date +%s%3N)
A='x-fleet-password: adm'
J=(-H content-type:application/json)
check() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  WRONG $1: wanted [$2], got [$3]"; fi
}
put() { curl -s -X PUT $B/api/projects/$1 -H "$A" "${J[@]}" -d "$2"; }
join() { curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/join -H 'authorization: Bearer node' "${J[@]}" -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}"; }
sync() { # machine run [status]
  curl -s -X POST $B/api/sync -H 'authorization: Bearer node' "${J[@]}" -d "{\"machine\":$1,\"run\":\"$2\",\"agent\":\"agent-$2\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":${3:-{\}},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":10,\"memUsed\":20,\"memTotal\":100},\"a\":{}}}}"
}
placed() { curl -s $B/api/status | jq -r ".projects[] | select(.name == \"$1\") | [.placed[] | select(.leaving | not) | .machine] | sort | join(\",\")"; }
blocked() { curl -s $B/api/status | jq -r ".projects[] | select(.name == \"$1\") | .blocked // \"none\""; }

echo "== three machines; web publishes 8080 on 2 replicas, api publishes 8080 too: api can't share a machine with web"
for m in 1 2 3; do join a$m $m > /dev/null; done
put web '{"port":8080,"compose":"services:\n  w:\n    image: x\n    ports: [\"8080:80\"]\n","replicas":2}' > /dev/null
for i in 1 2 3; do for m in 1 2 3; do sync $m r$m > /dev/null; done; done
check "web on two machines" 2 "$(placed web | tr ',' '\n' | wc -l)"
put api '{"port":8080,"compose":"services:\n  a:\n    image: y\n    ports: [\"127.0.0.1:8080:80/tcp\"]\n","replicas":2}' > /dev/null
for i in 1 2; do for m in 1 2 3; do sync $m r$m > /dev/null; done; done
free=$(comm -13 <(placed web | tr ',' '\n' | sort) <(echo -e "1\n2\n3") | tr '\n' ',' | sed 's/,$//')
check "api placed only on the machine without web, twice ($free)" "$free,$free" "$(placed api)"
check "api's second copy there has its port moved" true "$(curl -s $B/api/status | jq '.projects[] | select(.name == "api") | [.placed[] | .moved] | sort == [false, true]')"
check "nothing blocks api" none "$(blocked api)"
echo "== a container name clashes too, and a different port doesn't"
put named '{"port":9000,"compose":"services:\n  n:\n    image: z\n    container_name: shared\n    ports: [\"9000:80\"]\n"}' > /dev/null
put named2 '{"port":9001,"compose":"services:\n  n:\n    image: z\n    container_name: shared\n    ports: [\"9001:80\"]\n","replicas":3}' > /dev/null
for i in 1 2; do for m in 1 2 3; do sync $m r$m > /dev/null; done; done
check "named on one machine" 1 "$(placed named | tr ',' '\n' | grep -c .)"
check "named2 on the other two" 2 "$(placed named2 | tr ',' '\n' | grep -c .)"
check "named2's third replica waits: the name clashes elsewhere, and it can't double up" "every other machine already has an app using container name shared (named)" "$(blocked named2)"
echo "== moving api by hand onto a machine that has web is refused; once web is gone it's fine"
from=$(placed api | cut -d, -f1); to=$(placed web | cut -d, -f1)
check "move to a clashing machine" 409 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/projects/api/move?from=$from&replica=1&to=$to" -H "$A")"
curl -s -X DELETE $B/api/projects/web -H "$A" > /dev/null
for m in 1 2 3; do sync $m r$m > /dev/null; done
check "move once web is gone" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/projects/api/move?from=$from&replica=1&to=$to" -H "$A")"
echo "== only a replica count: the files stay as they are"
put files '{"port":7000,"dockerfile":"FROM a\n","files":{"x.txt":"one\n"}}' > /dev/null
r=$(put files '{"replicas":2}')
check "new version" 2 "$(echo "$r" | jq .version)"
check "replicas 2" 2 "$(echo "$r" | jq .replicas)"
check "files kept" '["Dockerfile","x.txt"]' "$(curl -s $B/api/projects/files | jq -c '.files | keys')"
check "sending the same count again is a no-op" true "$(put files '{"replicas":2}' | jq .unchanged)"
echo "== a Dockerfile-only app: the editor sends the generated compose back with a new port, and the compose follows"
gen=$(curl -s $B/api/projects/files | jq -r .compose)
r=$(curl -s -X PUT $B/api/projects/files -H "$A" "${J[@]}" -d "$(jq -n --arg c "$gen" '{compose: $c, files: {Dockerfile: "FROM a\n", "x.txt": "one\n"}, port: 7001}')")
check "port 7001" 7001 "$(echo "$r" | jq .port)"
check "compose publishes 7001" '    ports: ["7001:7001"]' "$(curl -s $B/api/projects/files | jq -r .compose | grep ports)"
check "replicas kept from the generated compose" 2 "$(echo "$r" | jq .replicas)"
echo "== a hand-written compose: the port must agree with x-runner.port"
check "disagreeing port refused" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/api/projects/hand -H "$A" "${J[@]}" -d '{"port":8001,"compose":"x-runner:\n  port: 8000\nservices:\n  h:\n    image: x\n"}')"
check "agreeing port accepted" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/api/projects/hand -H "$A" "${J[@]}" -d '{"port":8000,"compose":"x-runner:\n  port: 8000\nservices:\n  h:\n    image: x\n"}')"
echo "== the join token can't take slot 1 while machine 1 is up; after a roll asks machine 1 to hand over, its replacement can"
check "join for a live slot" 409 "$(join intruder 1)"
check "the live run isn't disturbed" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sync -H 'authorization: Bearer node' "${J[@]}" -d "{\"machine\":1,\"run\":\"r1\",\"agent\":\"agent-r1\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":{}}")"
curl -s -X POST "$B/api/roll?machine=1" -H "$A" > /dev/null
check "machine 1 is told to hand over" true "$(sync 1 r1 | jq .handover)"
check "its replacement joins for slot 1" 200 "$(join a1b 1)"
check "a slot nobody is in" 200 "$(join newcomer 4)"
grep -i "error\|exception" /tmp/runner-test-dev.log | grep -v "Cloudflare API" | head -5
. "$HERE/stop.sh"

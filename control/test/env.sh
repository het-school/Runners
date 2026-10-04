#!/bin/bash
# An app's env: KEY=value pairs kept by the control plane and written into every copy's .env, along with FLEET_*
# (which app, replica and machine the copy is). Values never come back out of the API; a change makes a new version;
# .env can't be sent as a file; a locked app's env takes its password.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
. "$HERE/start.sh" ADMIN_PASSWORD=adm JOIN_TOKEN=node 'POOLS={"main":2}'
B=localhost:8911; START=$(date +%s%3N)
A='x-admin-password: adm'
J='content-type: application/json'
join() { curl -s -X POST $B/api/join -H 'authorization: Bearer node' -H "$J" -d "{\"agent\":\"$1\",\"pool\":\"main\",\"want\":$2}" >/dev/null; }
# A machine checks in like an agent, with metrics: the control plane places nothing until every machine has reported some.
sync() { curl -s -X POST $B/api/sync -H 'authorization: Bearer node' -H "$J" -d "{\"machine\":$1,\"run\":\"r$1\",\"agent\":\"agent-r$1\",\"pool\":\"main\",\"started\":$START,\"ready\":true,\"status\":{},\"metrics\":{\"live\":{\"t\":$(date +%s%3N),\"h\":{\"cpu\":10,\"memUsed\":20,\"memTotal\":100},\"a\":{}}}}"; }
envfile() { sync $1 | jq -r ".desired[\"$2\"].files[\".env\"] // \"(no .env)\"" | sed 's/^/   /'; }
join a 1; join b 2; sync 1 >/dev/null; sync 2 >/dev/null
echo "== deploy web with 2 replicas: each copy's .env says which copy it is (no app variables yet):"
curl -s -X PUT $B/api/projects/web -H "$J" -d '{"port":8080,"compose":"services:\n  app:\n    image: x\n    ports: [\"8080:80\"]\n    environment: [\"R=${FLEET_REPLICA}\", \"S=${SECRET}\"]\n","replicas":2}' | jq -c '{name, version, env, error}'
sync 1 >/dev/null; sync 2 >/dev/null
echo "-- machine 1:"; envfile 1 web
echo "-- machine 2:"; envfile 2 web
echo "== set SECRET and PLAIN (open app, so no password needed): a new version with the same spec"
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"SECRET":"s3cret-value","PLAIN":"it'"'"'s $HOME \"quoted\"\nline2"}' | jq -c '{name, version, keys, error}'
echo "-- machine 1's .env now:"; envfile 1 web
echo "== the values never come back out: the project, its env and the status give the keys only:"
curl -s $B/api/projects/web | jq -c '{env, leaks: (tostring | contains("s3cret"))}'
curl -s $B/api/projects/web/env | jq -c .
curl -s $B/api/status | jq -c '{leaks: (tostring | contains("s3cret")), env: .projects[0].env}'
echo "== remove PLAIN (null); bad names, FLEET_ names, non-text values and .env as a file are refused:"
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"PLAIN":null}' | jq -c '{version, keys, error}'
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"bad-name":"x"}' | jq -c '{error}'
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"FLEET_APP":"x"}' | jq -c '{error}'
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"N":5}' | jq -c '{error}'
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{}' | jq -c '{error}'
curl -s -X PUT $B/api/projects/web -H "$J" -d '{"port":8080,"compose":"services:\n  app:\n    image: x\n","files":{".env":"A=b"}}' | jq -c '{error}'
echo "== lock web: env changes then need its password or the admin password:"
curl -s -X PUT $B/api/projects/web/password -H "$J" -d '{"password":"webpass123"}' | jq -c .
curl -s -X PUT $B/api/projects/web/env -H "$J" -d '{"SECRET":"new"}' | jq -c '{error}'
curl -s -X PUT $B/api/projects/web/env -H 'x-app-password: webpass123' -H "$J" -d '{"SECRET":"new"}' | jq -c '{version, keys, error}'
curl -s -X PUT $B/api/projects/web/env -H "$A" -H "$J" -d '{"ADMIN_SET":"yes"}' | jq -c '{version, keys, error}'
echo "-- machine 2's .env:"; envfile 2 web
echo "== a new app can bring its env along: the first version already has it (and a plain update with env only is a new version):"
curl -s -X PUT $B/api/projects/api -H "$J" -d '{"port":9000,"compose":"services:\n  app:\n    image: y\n    ports: [\"9000:80\"]\n","replicas":1,"env":{"TOKEN":"t0k"}}' | jq -c '{name, version, env, error}'
sync 1 >/dev/null; sync 2 >/dev/null
m=$(curl -s $B/api/status | jq -r '.projects[] | select(.name == "api") | .placed[0].machine')
echo "-- api's .env on machine $m:"; envfile $m api
curl -s -X PUT $B/api/projects/api -H "$J" -d '{"env":{"TOKEN":"t0k"}}' | jq -c '{version, unchanged, error}'
curl -s -X PUT $B/api/projects/api -H "$J" -d '{"env":{"TOKEN":"t1k"}}' | jq -c '{version, env, error}'
curl -s -X PUT $B/api/projects/api -H "$J" -d '{"env":"nope"}' | jq -c '{error}'
echo "== no such app:"
curl -s $B/api/projects/nope/env | jq -c .
echo "== export has the env table; deleting web removes its env:"
curl -s "$B/api/export?table=app_env" -H "$A" | jq -c '[.rows[] | "\(.name).\(.key)"]'
curl -s -X DELETE $B/api/projects/web -H "$A" | jq -c .
curl -s "$B/api/export?table=app_env" -H "$A" | jq -c '{rows: (.rows | length)}'
grep -i "error\|exception" /tmp/runner-test-dev.log | grep -v "Cloudflare API" | head -5
. "$HERE/stop.sh"

#!/bin/bash
# The UI's API: anyone can see everything and change projects; fleet changes need the password, and an address that
# gets it wrong 5 times is refused for a while.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var ADMIN_PASSWORD:hunter2 --var NODE_TOKEN:node --var 'POOLS:{"main":2}' --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
U=localhost:8911/admin/api
code() { curl -s -o /tmp/runner-test-body -w '%{http_code}' "$@"; echo " $(head -c 120 /tmp/runner-test-body)"; }

echo "== anyone: status, metrics, deploy, disable, enable, move, delete"
code $U/status | cut -c1-4
code "localhost:8911/api/metrics?range=1h" | cut -c1-4
code -X PUT $U/projects/web -H content-type:application/json -d '{"port":8080,"dockerfile":"FROM x"}'
code -X POST $U/projects/web/disable
code -X POST $U/projects/web/enable
code -X DELETE $U/projects/web
echo "== fleet changes without the password: refused"
code -X PUT $U/settings -H content-type:application/json -d '{"rebalance":false}'
code -X POST $U/roll
code -X POST $U/machines/1/evict
code -X DELETE $U/slots/9
code $U/join-token
echo "== unlock: wrong, then right"
code -X POST $U/unlock -H 'x-fleet-password: nope'
code -X POST $U/unlock -H 'x-fleet-password: hunter2'
echo "== fleet changes with the password"
code -X PUT $U/settings -H 'x-fleet-password: hunter2' -H content-type:application/json -d '{"rebalance":false}'
code -X POST $U/roll -H 'x-fleet-password: hunter2'
code $U/join-token -H 'x-fleet-password: hunter2'
echo "== the admin token still works on /api"
code -X PUT localhost:8911/api/settings -H 'authorization: Bearer adm' -H content-type:application/json -d '{"rebalance":true}'
echo "== 5 wrong passwords, then even the right one is refused for a while"
for i in 1 2 3 4 5; do code -X POST $U/unlock -H 'x-fleet-password: wrong' >/dev/null; done
code -X POST $U/unlock -H 'x-fleet-password: hunter2'
echo "== from another site: refused"
code -X PUT $U/projects/web -H 'origin: https://evil.example' -H content-type:application/json -d '{"port":8080,"dockerfile":"FROM x"}'
. "$HERE/stop.sh"

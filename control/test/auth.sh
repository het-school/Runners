#!/bin/bash
# The UI's API: anyone can see everything and deploy a new app, which sets that app's password; changing an app needs
# its password or the fleet password; fleet changes need the fleet password. An address that gets a password wrong 5
# times is refused for a while (counted per app, and for the fleet). Each line says ok, or WRONG with what came back.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
. "$HERE/stop.sh"
rm -rf /tmp/runner-test-state
(node "$HERE/cloudflare-mock.mjs" > /tmp/runner-test-mock.log 2>&1 &)
(setsid npx wrangler dev --port 8911 --var CF_API_BASE:http://127.0.0.1:8790 --var CF_API_TOKEN:x --var ADMIN_TOKEN:adm --var ADMIN_PASSWORD:hunter2 --var NODE_TOKEN:node --var 'POOLS:{"main":2}' --persist-to /tmp/runner-test-state > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done
U=localhost:8911/admin/api
A=localhost:8911/api
J=(-H content-type:application/json)
want() {
  local w=$1 c; shift
  c=$(curl -s -o /tmp/runner-test-body -w '%{http_code}' "$@")
  if [ "$c" = "$w" ]; then echo "  ok $c $(head -c 100 /tmp/runner-test-body)"; else echo "  WRONG: got $c, wanted $w: $(head -c 200 /tmp/runner-test-body)"; fi
}
has() { curl -s $U/status | jq -r ".projects[] | select(.name == \"$1\") | \"  $1 hasPassword: \(.hasPassword)\""; }

echo "== anyone: status and metrics"
want 200 $U/status
want 200 "$A/metrics?range=1h"
echo "== a new app needs a password of 6 or more characters"
want 400 -X PUT $U/projects/web "${J[@]}" -d '{"port":8080,"dockerfile":"FROM x"}'
want 400 -X PUT $U/projects/web "${J[@]}" -d '{"port":8080,"dockerfile":"FROM x","password":"short"}'
want 200 -X PUT $U/projects/web "${J[@]}" -d '{"port":8080,"dockerfile":"FROM x","password":"web-secret"}'
has web
echo "== the password (or its hash) is never sent out"
curl -s $U/projects/web $U/status | grep -c 'web-secret\|"salt"\|"hash"' | sed 's/^/  mentions: /'
echo "== changing it without its password: refused"
want 401 -X PUT $U/projects/web "${J[@]}" -d '{"port":8080,"dockerfile":"FROM y"}'
want 401 -X POST $U/projects/web/disable
want 401 -X POST "$U/projects/web/move?from=1"
want 401 -X DELETE $U/projects/web
want 401 -X POST $U/projects/web/unlock -H 'x-app-password: nope'
echo "== a password in the body only counts for a new app"
want 401 -X PUT $U/projects/web "${J[@]}" -d '{"port":8080,"dockerfile":"FROM y","password":"web-secret"}'
echo "== with its password"
want 200 -X POST $U/projects/web/unlock -H 'x-app-password: web-secret'
want 200 -X PUT $U/projects/web -H 'x-app-password: web-secret' "${J[@]}" -d '{"port":8080,"dockerfile":"FROM y"}'
want 200 -X POST $U/projects/web/disable -H 'x-app-password: web-secret'
want 200 -X POST $U/projects/web/enable -H 'x-app-password: web-secret'
echo "== another app's password doesn't open it"
want 200 -X PUT $U/projects/api "${J[@]}" -d '{"port":9090,"dockerfile":"FROM x","password":"api-secret"}'
want 401 -X POST $U/projects/web/disable -H 'x-app-password: api-secret'
echo "== the fleet password opens every app; a wrong one says so"
want 200 -X POST $U/projects/api/disable -H 'x-fleet-password: hunter2'
want 200 -X POST $U/projects/api/unlock -H 'x-fleet-password: hunter2'
want 401 -X POST $U/projects/api/enable -H 'x-fleet-password: nope'
echo "== changing the password needs the old one (or the fleet's); then only the new one works"
want 401 -X PUT $U/projects/web/password "${J[@]}" -d '{"password":"web-secret-2"}'
want 400 -X PUT $U/projects/web/password -H 'x-app-password: web-secret' "${J[@]}" -d '{"password":"x"}'
want 200 -X PUT $U/projects/web/password -H 'x-app-password: web-secret' "${J[@]}" -d '{"password":"web-secret-2"}'
want 401 -X POST $U/projects/web/unlock -H 'x-app-password: web-secret'
want 200 -X POST $U/projects/web/unlock -H 'x-app-password: web-secret-2'
echo "== an app deployed with the admin token and no password: only the fleet password changes it, until it gets one"
want 200 -X PUT $A/projects/legacy -H 'authorization: Bearer adm' "${J[@]}" -d '{"port":7070,"dockerfile":"FROM x"}'
has legacy
want 401 -X POST $U/projects/legacy/disable
want 401 -X POST $U/projects/legacy/disable -H 'x-app-password: anything'
want 200 -X POST $U/projects/legacy/disable -H 'x-fleet-password: hunter2'
want 200 -X PUT $U/projects/legacy/password -H 'x-fleet-password: hunter2' "${J[@]}" -d '{"password":"legacy-pass"}'
want 200 -X POST $U/projects/legacy/enable -H 'x-app-password: legacy-pass'
has legacy
echo "== the admin token on /api changes any app; without a token /api refuses"
want 200 -X POST $A/projects/web/disable -H 'authorization: Bearer adm'
want 401 -X POST $A/projects/web/enable
echo "== 5 wrong passwords for web: web refuses this address for a while, even the right one; api and the fleet don't"
for i in 1 2 3 4 5; do want 401 -X POST $U/projects/web/unlock -H 'x-app-password: wrong' >/dev/null; done
want 429 -X POST $U/projects/web/unlock -H 'x-app-password: web-secret-2'
want 200 -X POST $U/projects/api/unlock -H 'x-app-password: api-secret'
want 200 -X POST $U/unlock -H 'x-fleet-password: hunter2'
want 200 -X POST $U/projects/web/enable -H 'x-fleet-password: hunter2'
echo "== deleting an app deletes its password: the name can be deployed again with a new one"
want 200 -X DELETE $U/projects/api -H 'x-app-password: api-secret'
want 200 -X PUT $U/projects/api "${J[@]}" -d '{"port":9090,"dockerfile":"FROM x","password":"new-owner"}'
want 401 -X POST $U/projects/api/unlock -H 'x-app-password: api-secret'
want 200 -X POST $U/projects/api/unlock -H 'x-app-password: new-owner'
echo "== fleet changes without the password: refused"
want 401 -X PUT $U/settings "${J[@]}" -d '{"rebalance":false}'
want 401 -X POST $U/roll
want 401 -X POST $U/machines/1/evict
want 401 -X DELETE $U/slots/9
want 401 $U/join-token
echo "== unlock: wrong, then right"
want 401 -X POST $U/unlock -H 'x-fleet-password: nope'
want 200 -X POST $U/unlock -H 'x-fleet-password: hunter2'
echo "== fleet changes with the password"
want 200 -X PUT $U/settings -H 'x-fleet-password: hunter2' "${J[@]}" -d '{"rebalance":false}'
want 200 -X POST $U/roll -H 'x-fleet-password: hunter2'
want 200 $U/join-token -H 'x-fleet-password: hunter2'
echo "== the admin token still works on /api"
want 200 -X PUT $A/settings -H 'authorization: Bearer adm' "${J[@]}" -d '{"rebalance":true}'
echo "== 5 wrong fleet passwords, then even the right one is refused for a while"
for i in 1 2 3 4 5; do want 401 -X POST $U/unlock -H 'x-fleet-password: wrong' >/dev/null; done
want 429 -X POST $U/unlock -H 'x-fleet-password: hunter2'
echo "== from another site: refused"
want 403 -X PUT $U/projects/web -H 'origin: https://evil.example' "${J[@]}" -d '{"port":8080,"dockerfile":"FROM x"}'
. "$HERE/stop.sh"

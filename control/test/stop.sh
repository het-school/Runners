# Sourced by the tests, before and after a run: stops the mock and the whole wrangler dev tree. Killing only the
# listener leaves wrangler running, and it starts a fresh workerd whenever a source file changes. The tests start
# wrangler in a session of its own (setsid), so that session can go without touching the caller's.
own=$(ps -o sid= -p $$ | tr -d ' ')
for s in $(ps -eo sid=,args= | grep -F -- "--persist-to /tmp/runner-test-state" | awk '{print $1}' | sort -u); do
  [ "$s" != "$own" ] && pkill -9 -s "$s"
done
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done

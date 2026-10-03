#!/bin/bash
# Starts the control plane for a test on 127.0.0.1:8911 with a fresh database, the fake Cloudflare API at :8790 and
# whatever VAR=value settings follow (ADMIN_PASSWORD, JOIN_TOKEN, POOLS, HOT_MS...). Logs to /tmp/runner-test-dev.log.
# Sourced by the tests after stop.sh; stop.sh ends it (by its port).
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rm -rf /tmp/runner-test-state
(cd "$HERE/.." && env PORT=8911 DATA_DIR=/tmp/runner-test-state DOMAIN=billybishop4-workers.xyz CONTROL_HOST=localhost:8911 \
  ZONE=44fb65648f475249f22e9d0cffdd393d ACCOUNT_ID=test-account MAX_SLOTS=50 CF_API_BASE=http://127.0.0.1:8790 CF_API_TOKEN=x \
  "$@" setsid node server.mjs > /tmp/runner-test-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -sf localhost:8911/api/status >/dev/null && break; sleep 1; done

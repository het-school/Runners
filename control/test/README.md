# Control plane tests

Scenario scripts that run the control plane locally (`node server.mjs`) against a fake Cloudflare API
(`cloudflare-mock.mjs`, which answers tunnel, DNS and route calls), then drive it with curl as the agents and the
portal would. Each prints what happened; read the output.

```sh
control/test/placement.sh   # replicas and placement by capacity
control/test/moves.sh       # moving replicas, evicting a machine
control/test/rebalance.sh   # automatic rebalancing (uses a 20-second hot window)
control/test/replicas.sh    # replica numbers, their routes and DNS names
control/test/pools.sh       # pool sizes, who starts machines, draining by agent ID
control/test/auth.sh        # what needs an app's password, the admin password, or nothing (prints ok/WRONG)
control/test/clashes.sh     # port and container-name clashes in placement, replica-only deploys, the generated compose, the join guard (ok/WRONG)
control/test/doubling.sh    # more replicas than machines: second copies with moved ports, their routes, moves by replica (ok/WRONG)
```

They need Node 24 (`node:sqlite`), `jq` and `curl`, and use ports 8911 (control plane, started by `start.sh`) and 8790 (mock).

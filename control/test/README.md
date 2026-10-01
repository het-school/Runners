# Control plane tests

Scenario scripts that run the control plane locally with `wrangler dev` against a fake Cloudflare API
(`cloudflare-mock.mjs`, which answers tunnel, DNS and route calls), then drive it with curl as the agents and the
portal would. Each prints what happened; read the output.

```sh
control/test/placement.sh   # replicas and placement by capacity
control/test/moves.sh       # moving replicas, evicting a machine
control/test/rebalance.sh   # automatic rebalancing (uses a 20-second hot window)
control/test/stateful.sh    # stateful projects: spec, per-machine rendering, handovers, stop-first moves
```

`e2e-stateful.sh` is different: it drives the *live* fleet with a throwaway stateful project (`e2e-stateful.yml`, a tiny
file store). `deploy`, `write`, `read`, `objects`, `state`, `wait <machine>` and `machine` are its phases; move the
project with `runnerctl move`, hand a machine over with `runnerctl roll`, and `read` again to see the data follow.
It needs `~/.config/runnerctl/token` and `~/.config/runnerctl/r2.env`.

They need Node, `npx wrangler`, `jq` and `curl`, and use ports 8911 (control plane) and 8790 (mock).

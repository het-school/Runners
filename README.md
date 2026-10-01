# runner

A self-healing fleet on GitHub Actions: 10 machines each run every project, each machine is online through its own Cloudflare tunnel, and the project specs live in a control plane on Cloudflare (not in this repo).

**Status page:** https://control.billybishop4-workers.xyz

## How it works

- **Control plane** ([`control/`](control)): a Cloudflare Worker with a Durable Object (its own SQLite database). It:
  - holds every project's spec and version history
  - rolls each change out one machine at a time, and stops and rolls back if a machine reports the new version unhealthy
  - tracks which machines are up and hands out restarts
  - keeps the DNS for `<project>-<n>` pointed at tunnel `runner-<n>`
- **Agent** ([`agent/agent.mjs`](agent/agent.mjs)), run by [`machine.yml`](.github/workflows/machine.yml) on every machine. It:
  - checks in every 20 seconds
  - starts, updates and removes compose projects to match its spec
  - restarts projects that stop answering
  - serves `https://<project>-<n>.billybishop4-workers.xyz` through a local router behind the tunnel
- **Self-healing**:
  - Before GitHub's 6-hour limit, each machine starts a fresh run of itself and leaves once the new one is healthy. This happens one machine at a time.
  - If a machine dies, the others start a replacement within about 2 minutes.
  - [`watchdog.yml`](.github/workflows/watchdog.yml) runs every 10 minutes and starts machines if none are left. It also does the first start.

## Projects

A project is a docker compose file. `x-runner.port` is the port to put online:

```yaml
x-runner:
  port: 11470
services:
  server:
    image: stremio/server:latest
    ports: ["11470:11470"]
    environment:
      NO_CORS: "1"
    restart: unless-stopped
```

For a custom image, give the service a `build:` with `dockerfile_inline:` or a git repo URL as the context. Every machine builds it when the spec changes. Ports 2019 and 19080 are taken by the router.

Manage projects with [`bin/runnerctl`](bin/runnerctl). It reads the admin token from `~/.config/runnerctl/token`.

```
runnerctl apply examples/stremio.yml         # add or update; rolls out machine by machine
runnerctl apply examples/stremio.yml --now   # update every machine at once
runnerctl status
runnerctl get stremio
runnerctl rm stremio
runnerctl roll [n]                           # replace machines one at a time (done automatically when agent/ changes)
runnerctl machines 10
```

## Setup notes

- **Repo secrets:** `CONTROL_NODE_TOKEN`, plus `CF_TUNNEL_TOKEN_1` to `CF_TUNNEL_TOKEN_10`.
- **Worker secrets:** `ADMIN_TOKEN`, `NODE_TOKEN` and `CF_DNS_TOKEN`. To deploy, run `wrangler deploy` in `control/`.
- **More machines:** create tunnel `runner-<n>`, add its `CF_TUNNEL_TOKEN_<n>` secret and its ID in `control/wrangler.toml`, deploy, then run `runnerctl machines <n>`. GitHub Free runs 20 jobs at once, and a replacement overlaps the run it replaces, so stay at about 18 or fewer.
- **Watchdog pausing:** GitHub pauses scheduled workflows in public repos after 60 days without repo activity.

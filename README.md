# runner

A self-healing fleet on GitHub Actions: 10 machines each run every project, each machine is online through its own Cloudflare tunnel, and the project specs live in a control plane on Cloudflare (not in this repo).

- **Status page:** https://control.billybishop4-workers.xyz
- **Admin portal:** https://control.billybishop4-workers.xyz/admin. It's open, with no sign-in, so anyone with the URL can use it. From the portal you can:
  - add projects and edit them
  - roll back to an earlier version
  - disable, enable and delete projects
  - restart machines
  - set how many machines run

## Projects

A project is a docker compose file, optionally with Dockerfiles and other files its builds need. Machine *n* serves it at `https://<project>-<n>.billybishop4-workers.xyz` on its port. That port comes from the `port` field, or from `x-runner.port` in the compose file.

- **Compose only:** services use published images.

  ```yaml
  x-runner:
    port: 11470
  services:
    server:
      image: stremio/server:latest
      ports: ["11470:11470"]
      restart: unless-stopped
  ```

- **Dockerfile only:** a custom image. The control plane wraps it in a one-service compose file (`build: .`) that publishes the port. The app should listen on that port.
- **Compose plus files:** files sit next to the compose file, so `build: .` or `build: ./web` (with `web/Dockerfile`) find them. You can also include whatever the Dockerfiles `COPY`, as long as it's text. Every machine builds the image when the version changes.

The control plane checks a spec before accepting it. It must be valid YAML with a `services:` section, every local `build:` needs its Dockerfile, and file paths must stay inside the project. Ports 2019 and 19080 are taken by the router.

### Rollouts

Each change is a new version, and every machine switches to it at once. There's no automatic rollback: if the new version fails, the machines show it as failed until you deploy a fix or load an earlier version in the portal and deploy it. A disabled project keeps its spec and versions but runs nowhere.

## API

The portal uses `/admin/api/*`, which needs no token. Scripts use `/api/*` with `Authorization: Bearer <admin token>`.

```
GET    /api/status                              projects and machines (no token needed)
PUT    /api/projects/<name>                     create or update: {"compose": "...", "dockerfile": "...",
                                                "files": {"path": "text"}, "port": 8080}  (compose or dockerfile required)
GET    /api/projects/<name>[?version=N]         a version's compose file, files and port, plus the version list
POST   /api/projects/<name>/disable | /enable   stop / start it on every machine
DELETE /api/projects/<name>                     delete it and its versions
POST   /api/roll[?machine=N]                    replace machines one at a time
PUT    /api/settings                            {"machines": 10}
```

```sh
curl -X PUT https://control.billybishop4-workers.xyz/api/projects/hello \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dockerfile": "FROM python:3.12-alpine\nCMD [\"python\", \"-m\", \"http.server\", \"9000\"]", "port": 9000}'
```

[`bin/runnerctl`](bin/runnerctl) wraps the API. It reads the token from `~/.config/runnerctl/token`.

```
runnerctl apply examples/hello --port 9000   # a folder: Dockerfile + what it COPYs (+ compose file, if any)
runnerctl apply examples/stremio.yml         # a compose file
runnerctl apply path/to/Dockerfile myapp --port 8000
runnerctl status | get <name> [version] | disable <name> | enable <name> | rm <name>
runnerctl roll [n] | machines <n>
```

## How it works

- **Control plane** ([`control/`](control)): a Cloudflare Worker with a Durable Object (its own SQLite database). It:
  - holds every project's versions
  - runs the rollouts
  - tracks machines and hands out restarts
  - keeps the DNS for `<project>-<n>` pointed at tunnel `runner-<n>`
- **Agent** ([`agent/agent.mjs`](agent/agent.mjs)), run by [`machine.yml`](.github/workflows/machine.yml) on every machine. It:
  - checks in every 20 seconds
  - writes each project's files and runs `docker compose up -d --build --wait`
  - removes what's no longer wanted
  - restarts projects that stop answering
  - routes `<project>-<n>` hostnames through a local Caddy router behind the tunnel
- **Self-healing**:
  - Each machine hands over to a fresh run of itself before GitHub's 6-hour limit, one machine at a time, without downtime.
  - If a machine dies, the others start a replacement within about 2 minutes.
  - [`watchdog.yml`](.github/workflows/watchdog.yml) runs every 10 minutes and starts machines if none are left.
  - [`roll.yml`](.github/workflows/roll.yml) restarts the fleet one machine at a time when the agent changes.

## Setup notes

- **Repo secrets:** `CONTROL_NODE_TOKEN`, plus `CF_TUNNEL_TOKEN_1` to `CF_TUNNEL_TOKEN_10`.
- **Worker secrets:** `ADMIN_TOKEN`, `NODE_TOKEN` and `CF_DNS_TOKEN` (a DNS-only token for this zone).
- **Deploy:** run `npm install && wrangler deploy` in `control/`.
- **Portal:** `/admin` and `/admin/api/*` are open, with no sign-in. Changes sent from other sites are refused.
- **More machines:** create tunnel `runner-<n>`, add `CF_TUNNEL_TOKEN_<n>` and the tunnel ID to `wrangler.toml`, deploy, then raise the machine count. GitHub Free runs 20 jobs at once, and handovers overlap briefly, so stay at about 18 or fewer.
- **Watchdog pausing:** GitHub pauses scheduled workflows in public repos after 60 days without repo activity.

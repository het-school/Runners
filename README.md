# runner

A self-healing fleet: GitHub Actions machines (10 by default) plus any of your own hosts that join, each online through its own Cloudflare tunnel. A project says how many replicas it wants, and the control plane places them on the machines with the most room. The project specs live in a control plane on Cloudflare (not in this repo), and machines find it: each one that starts up claims a free slot *n*, and the control plane creates tunnel `runner-n` for it the first time that slot is used.

- **Status page:** https://control.billybishop4-workers.xyz
- **Metrics:** https://control.billybishop4-workers.xyz/metrics shows CPU, memory, disk I/O and network I/O for the whole fleet, for each machine and for each app. History is kept at 1-minute resolution for 48 hours and at 10-minute resolution for 30 days.
- **Admin portal:** https://control.billybishop4-workers.xyz/admin (step-by-step deploy guide for the portal and the API at [/admin#guide](https://control.billybishop4-workers.xyz/admin#guide)). It's open, with no sign-in, so anyone with the URL can use it. From the portal you can:
  - add projects and edit them
  - roll back to an earlier version
  - disable, enable and delete projects
  - restart machines
  - set how many machines run

## Projects

A project is a docker compose file, optionally with Dockerfiles and other files its builds need, plus a replica count: how many machines run it (default 1), or `all`. It's served at `https://<project>.billybishop4-workers.xyz`, which goes to a machine where it's healthy (each visitor sticks to one machine), and machine *n* also serves it at `https://<project>-<n>.billybishop4-workers.xyz`. That port comes from the `port` field, or from `x-runner.port` in the compose file.

- **Compose only:** services use published images.

  ```yaml
  x-runner:
    port: 11470
    replicas: 3
  services:
    server:
      image: stremio/server:latest
      ports: ["11470:11470"]
      restart: unless-stopped
  ```

- **Dockerfile only:** a custom image. The control plane wraps it in a one-service compose file (`build: .`) that publishes the port. The app should listen on that port.
- **Compose plus files:** files sit next to the compose file, so `build: .` or `build: ./web` (with `web/Dockerfile`) find them. You can also include whatever the Dockerfiles `COPY`, as long as it's text. Every machine builds the image when the version changes.

The control plane checks a spec before accepting it. It must be valid YAML with a `services:` section, every local `build:` needs its Dockerfile, and file paths must stay inside the project. Ports 2019 and 19080 are taken by the router.

### Stateful projects

A project is stateless unless it says otherwise. A stateful one names the directory where it keeps its state and how much it may keep there:

```yaml
x-runner:
  port: 8080
  state: stateful
  data: /data        # mounted into every service
  storage: 200M      # per replica; default 100M, max 500M
```

Each replica gets its own directory in the fleet's storage, a Cloudflare R2 bucket, mounted (with rclone) on whichever machine runs it and bound into its containers at `data`. The app just uses the directory. When the replica moves, its machine goes, or the machine hands over to a fresh run, the next machine mounts the same directory and finds everything there. Replicas don't share data, so a stateful app should usually run one replica. Over the storage limit, the replica's data turns read-only until the limit is raised or data is cleared (the portal shows usage, measured every 5 minutes, and can wipe a disabled project's data).

What the mount is and isn't: a file is in R2 once the app closes it, reads and writes go through a local cache at disk speed, and files the app still had open when a machine died unexpectedly are lost. That suits files (uploads, content, configs, caches). It doesn't suit databases that keep one file open the whole time (SQLite, Postgres); those need their own replication.

Moving a stateful replica (by hand, by eviction, or a handover) stops it first, waits for its last writes to reach R2, then starts it on the next machine: about a minute of downtime for that project. Automatic rebalancing leaves single-replica stateful projects alone for that reason.

### Placement

Each replica goes to the machine with the most room: the least CPU and memory in use (from the machine's latest metrics) and the fewest projects already placed on it. A replica stays on its machine until that machine goes away (its run stops checking in); then it moves to the best machine left, within about a minute. To move one by hand (you're about to remove the machine, say), use **Move** in the project's details or **Move apps off** on the machine: the new copy is placed first, and the old one is removed once the new one is healthy, so nothing goes down.

Rebalancing is automatic (switch it off in the portal or with `runnerctl rebalance off`): a machine that's hot (CPU over 85% or memory over 90% on every sample for 5 minutes) has its heaviest placed project moved off, and a machine carrying 2 or more placed projects than the emptiest one hands one over. The destination must have room (CPU under 70%, memory under 80%). It's one move at a time, at most one every 10 minutes, and no project twice in 30 minutes, so it can't thrash. Projects set to `all` never move. The portal lists what moved and why. Lowering the count removes the newest placements first; raising it adds more. With `replicas: all` the project runs on every machine, placed or not. The portal shows where each replica landed and why.

### Rollouts

Each change is a new version, and every machine switches to it at once. There's no automatic rollback: if the new version fails, the machines show it as failed until you deploy a fix or load an earlier version in the portal and deploy it. A disabled project keeps its spec and versions but runs nowhere.

## API

The portal uses `/admin/api/*`, which needs no token. Scripts use `/api/*` with `Authorization: Bearer <admin token>`.

```
GET    /api/status                              projects and machines (no token needed)
GET    /api/metrics?range=1h|6h|24h|7d|30d      metrics columns per machine and app, plus live samples (no token needed)
PUT    /api/projects/<name>                     create or update: {"compose": "...", "dockerfile": "...", "files": {"path": "text"},
                                                "port": 8080, "replicas": 3 | "all", "state": "stateful", "data": "/data",
                                                "storage": 200}  (compose or dockerfile required)
POST   /api/projects/<name>/wipe[?replica=r0]   delete a disabled stateful project's data (one replica's, or all)
GET    /api/projects/<name>[?version=N]         a version's compose file, files and port, plus the version list
POST   /api/projects/<name>/disable | /enable   stop / start it on every machine
DELETE /api/projects/<name>                     delete it and its versions
POST   /api/roll[?machine=N]                    replace machines one at a time
PUT    /api/settings                            {"machines": 10, "rebalance": true}  (GitHub machines to keep running; automatic rebalancing)
POST   /api/projects/<name>/move?from=N[&to=M]  move one copy off machine N (to M, or the machine with the most room)
POST   /api/machines/<n>/evict                  move every placed project off machine n
GET    /api/join-token                          the token a host joins with (admin token only)
POST   /api/join                                an agent starting up: {"agent", "kind", "want"} -> its slot and tunnel token
```

```sh
curl -X PUT https://control.billybishop4-workers.xyz/api/projects/hello \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dockerfile": "FROM python:3.12-alpine\nCMD [\"python\", \"-m\", \"http.server\", \"9000\"]", "port": 9000}'
```

[`bin/runnerctl`](bin/runnerctl) wraps the API. It reads the token from `~/.config/runnerctl/token`.

```
runnerctl apply examples/hello --port 9000 --replicas 3   # a folder: Dockerfile + what it COPYs (+ compose file, if any)
runnerctl apply examples/stremio.yml         # a compose file
runnerctl apply path/to/Dockerfile myapp --port 8000
runnerctl status | get <name> [version] | disable <name> | enable <name> | rm <name>
runnerctl roll [n] | machines <n>
```

## Your own machines

Any Linux machine with Docker can join. Get the token with `runnerctl join-token`, then on the machine:

```sh
curl -fsSL https://control.billybishop4-workers.xyz/install.sh | sudo JOIN_TOKEN=<token> sh
```

It runs the agent in the container `runner-agent`, takes the lowest free slot (and gets the same one back after a restart), and fetches the latest agent code whenever it starts; restarting machines from the portal restarts it. Hosts don't count toward the GitHub machine count. Remove one with `docker rm -f runner-agent tunnel router`.

## How it works

- **Control plane** ([`control/`](control)): a Cloudflare Worker with a Durable Object (its own SQLite database). It:
  - holds every project's versions
  - places each project's replicas on the machines with the most room, and moves them when a machine goes
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

- **Repo secrets:** `CONTROL_NODE_TOKEN` (the same value as the Worker's `NODE_TOKEN`). Tunnel tokens come from the control plane.
- **Worker secrets:** `ADMIN_TOKEN`, `NODE_TOKEN` and `CF_API_TOKEN`: a token with Cloudflare Tunnel edit on the account and DNS edit plus Workers Routes edit on the zone. For stateful projects: `FS_ACCESS_KEY_ID` and `FS_SECRET_ACCESS_KEY` (an R2 token limited to the bucket in `FS_BUCKET`), with `FS_ENDPOINT` and the `FS` bucket binding in `wrangler.toml`.
- **Deploy:** run `npm install && wrangler deploy` in `control/`.
- **Portal:** `/admin` and `/admin/api/*` are open, with no sign-in. Changes sent from other sites are refused.
- **More machines:** raise the GitHub machine count in the portal (tunnels are made as needed, up to `MAX_SLOTS`). GitHub Free runs 20 jobs at once, and handovers overlap briefly, so stay at about 18 or fewer. Cloudflare allows 1,000 tunnels per account.
- **Watchdog pausing:** GitHub pauses scheduled workflows in public repos after 60 days without repo activity.

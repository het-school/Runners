# runner

A self-healing fleet of machines that join a control plane: pools of GitHub Actions machines plus any of your own hosts, each online through its own Cloudflare tunnel. A project says how many replicas it wants, and the control plane places them on the machines with the most room. The control plane is one Node process with a SQLite file ([`control/`](control)), running on a server of yours behind its own Cloudflare tunnel; Cloudflare provides nothing else than the tunnels and the DNS names. Machines find it: each one that starts up claims a free slot *n*, and the control plane creates tunnel `runner-n` for it the first time that slot is used.

Neither the control plane nor the agent knows what a machine is, where it comes from, or how long it lives; they're told. An agent describes its machine with a **pool** (the name of a replaceable set it belongs to, which the control plane keeps at its size; or none, for a standalone host that keeps its slot across restarts), whether it **starts** machines (it has a `START_CMD`), an optional label (a name for the pages; `install.sh` uses the host's hostname), and sends **leaving** on its last check-in when it's going for good. Whatever runs the machine pings **`POST /api/drain`** when it's going down soon, and the control plane hands the machine over (one at a time, as for a requested roll). Everything about GitHub Actions lives in [`machine.yml`](.github/workflows/machine.yml): the job's 6-hour lifetime, a timer that drains the machine 4h15m-5h15m in at random, and the command that starts another machine.

- **Web app:** https://runners.billybishop4-workers.xyz (the older name, control.billybishop4-workers.xyz, still works), one page with views for an overview (what needs attention first), apps, machines, metrics, fleet settings and a deploy guide. It works on phones too, with a bottom tab bar. `/admin` and `/metrics` redirect to it, and their old links still land in the right place.
  - **Open to everyone:** seeing everything (apps, machines, metrics, deployments), deploying an app, and changing or removing any app that isn't locked: editing, rolling back (with a diff of what changes), changing replicas, moving a replica, disabling or deleting it (deleting asks you to type the name). No account, no token.
  - **A locked app needs its app password:** whoever deploys an app can give it an app password (optional), or lock it later from its page or with `runnerctl password <name>`; changing it then needs that app password, which the browser keeps for the session (or on that device if you tick the box). The admin password works for every app too.
  - **Needs the admin password (the fleet owner's):** changing the fleet, which covers automatic rebalancing, restarting machines, moving every app off a machine, retiring slots, and showing the join command for a new machine. Those controls show a lock, and using one asks for the password once per browser session (or remembers it on that device if you tick the box).
  - **Metrics:** CPU, memory, disk I/O and network I/O for the whole fleet, for each machine and for each app. History is kept at 1-minute resolution for 48 hours, 10-minute resolution for 3 days and hourly for 30 days.

## Projects

A project is a docker compose file, optionally with Dockerfiles and other files its builds need, plus a replica count: how many copies of it run (from 1 to 50, default 1), spread over the machines with the most room; with more replicas than machines, some machines run two or more copies. Each replica has its own URL and there's no shared one in front of them: replicas are numbered from 1, and replica *k* is at `https://<project>-<k>.billybishop4-workers.xyz`, a DNS name the control plane points at the tunnel of whichever machine runs that copy (and moves when the copy moves), so these URLs only change when the replica count does. The port comes from the `port` field, or from `x-runner.port` in the compose file.

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

Project names are lowercase letters, digits and dashes, and can't end in `-<number>` or `-m<number>` (those are replica and machine URLs). The control plane checks a spec before accepting it. It must be valid YAML with a `services:` section, every local `build:` needs its Dockerfile, file paths must stay inside the project, and a `port` given alongside the compose file must agree with its `x-runner.port`. Ports 2019 and 19080 are taken by the router. Apps deployed without the admin password get an ordinary container only: their compose files can't reach the machine itself (host folders, the Docker socket, privileged mode, host networking and so on are refused with a message naming the setting).

Sending only `{"replicas": N}` (or only a port) for an existing project makes a new version with the latest version's files, so a replica change never puts back files someone else has changed since.

### Placement

Each replica goes to the machine with the most room: the least CPU and memory in use (from the machine's latest metrics) and the fewest copies already placed on it, machines that don't run the project yet first. Once every machine has a copy, the next replicas double up on the least busy machines: the second copy on a machine runs as compose project `<name>-r<k>` with its published host ports moved out of the first copy's way; each copy answers its own replica's name, so the machine's router tells them apart. A project can't double up if its compose file uses `network_mode: host`, a `container_name` or variables in `ports`; that replica waits and the app's page says why. Two different projects that publish the same host port, or use the same `container_name`, are never placed on one machine either (the second would fail to start). A replica stays on its machine until that machine goes away (its run stops checking in); then it moves to the best machine left, within about a minute, keeping its number and URL. To move one by hand (you're about to remove the machine, say), use **Move** in the project's details or **Move apps off** on the machine: the new copy is placed first, and the old one is removed once the new one is healthy, so nothing goes down.

Rebalancing is automatic (switch it off on the Fleet page or with `runnerctl rebalance off`): a machine running two copies of a project while another machine with room runs none of it hands one over; a machine that's hot (CPU over 85% or memory over 90% on every sample for 5 minutes) has its heaviest placed copy moved off; and a machine carrying 2 or more placed copies than the emptiest one hands one over. The destination must have room (CPU under 70%, memory under 80%). It's one move at a time, at most one every 10 minutes, and no project twice in 30 minutes, so it can't thrash. The Fleet page lists what moved and why. Lowering the count removes the highest-numbered replicas; raising it adds the next numbers. Each app's page shows where each replica landed and why.

### Rollouts

Each change is a new version, and every machine switches to it at once. Nothing is rolled back automatically (dropped on purpose): a failing version stays failing, and the app's page shows each failing machine's error until you deploy a fix or roll back from the Versions list. A disabled project keeps its spec and versions but runs nowhere.

## API

The web app uses `/admin/api/*`; scripts use `/api/*`; they're the same API. Reading and deploying are open: `PUT /projects/<name>` creates or updates an app with no credentials. A `"password"` (6+ characters) in a new app's body locks it; from then on changing it (`PUT`, `/enable`, `/disable`, `/move`, `DELETE`, and `PUT /projects/<name>/password` with `{"password": "new"}`, which also locks an open app) needs the header `x-app-password` or `x-admin-password`. Fleet routes (`/settings`, `/roll`, `/machines/<n>/evict`, `/slots/<n>`, `/join-token`) need `x-admin-password`. App passwords are stored as salted PBKDF2 hashes and never sent out; the status only says `hasPassword`. An address that sends a wrong password 5 times is refused for 15 minutes, counted separately for the fleet and for each app. Deploys without the admin password get an ordinary container only (see Projects). Machines use `/api/*` with the join token (`Authorization: Bearer <join token>`).

```
GET    /api/status                              projects and machines (no token needed)
GET    /api/metrics?range=1h|6h|24h|7d|30d      metrics columns per machine and app, plus live samples (no token needed)
PUT    /api/projects/<name>                     create or update: {"compose": "...", "dockerfile": "...", "files": {"path": "text"},
                                                "port": 8080, "replicas": 3}  (compose or dockerfile required)
GET    /api/projects/<name>[?version=N]         a version's compose file, files and port, plus the version list
POST   /api/projects/<name>/disable | /enable   stop / start it on every machine
DELETE /api/projects/<name>                     delete it and its versions
POST   /api/roll[?machine=N]                    replace machines one at a time
PUT    /api/settings                            {"pools": {"<pool>": 10}, "rebalance": true}  (machines to keep per pool; automatic rebalancing)
POST   /api/projects/<name>/move?from=N[&to=M][&replica=K]  move one copy off machine N (to M, or the machine with the most room)
POST   /api/machines/<n>/evict                  move every placed project off machine n
DELETE /api/slots/<n>                           retire an empty slot: tunnel, records and DNS names go
GET    /api/join-token                          the join token (needs the admin password)
POST   /api/join                                an agent starting up: {"agent", "pool", "url", "label", "want"} -> its slot and tunnel token
POST   /api/claim?pool=<name>                    machines to start so the pool has its size (for a watchdog outside the pool)
POST   /api/drain                               {"agent": id}, {"run": id} or {"machine": n}: it's going down soon, hand it over
```

```sh
curl -X PUT https://runners.billybishop4-workers.xyz/api/projects/hello -H 'Content-Type: application/json' \
  -d '{"dockerfile": "FROM python:3.12-alpine\nCMD [\"python\", \"-m\", \"http.server\", \"9000\"]", "port": 9000}'
```

[`bin/runnerctl`](bin/runnerctl) wraps the API. It sends the admin password if it has one (`$ADMIN_PASSWORD` or `~/.config/runnerctl/admin-password`), which locked apps and fleet changes need; everything else works without.

```
runnerctl apply examples/hello --port 9000 --replicas 3   # a folder: Dockerfile + what it COPYs (+ compose file, if any)
runnerctl apply examples/stremio.yml         # a compose file
runnerctl apply path/to/Dockerfile myapp --port 8000
runnerctl status | get <name> [version] | disable <name> | enable <name> | rm <name>   # status marks a doubled-up copy with *
runnerctl roll [n] | pool <name> <n>
```

## Your own machines

Any Linux machine with Docker can join. Get the command, token included, from the Fleet page ("Add a machine"), or the token with `runnerctl join-token`, then on the machine:

```sh
curl -fsSL https://runners.billybishop4-workers.xyz/install.sh | sudo JOIN_TOKEN=<token> sh
```

Add `LABEL=<name>` to name it on the status pages. A machine joined this way stands on its own (no pool) and keeps its slot across restarts; the web app doesn't show pools at all, it's just one set of machines.

It runs the agent in the container `runner-agent`, takes the lowest free slot (and gets the same one back after a restart), and fetches the latest agent code whenever it starts; restarting it from the web app restarts the agent. A host without `POOL` is standalone and doesn't count toward any pool's size. Remove one with `docker rm -f runner-agent tunnel router`, then retire its slot from the web app or with `runnerctl retire <n>` so its tunnel and `<app>-m<n>` names go too.

## How it works

- **Control plane** ([`control/`](control)): one Node process (`server.mjs`) with a SQLite file, reached through its own Cloudflare tunnel at `runners.<domain>`. It:
  - holds every project's versions
  - places each project's replicas on the machines with the most room, and moves them when a machine goes
  - runs the rollouts
  - tracks machines and hands out restarts
  - keeps the DNS in line: `<project>-<k>` is a CNAME to the tunnel of the machine running replica *k*, moved when the copy moves
- **Agent** ([`agent/agent.mjs`](agent/agent.mjs)), on every machine (run by [`machine.yml`](.github/workflows/machine.yml) on GitHub Actions, by `install.sh` on a host). It's configured by environment variables (listed at the top of the file) and:
  - checks in every 20 seconds, describing its machine: pool, label, whether it starts machines
  - writes each project's files and runs `docker compose up -d --build --wait`; a project that fails is tried again (every 30 seconds while the machine is starting up, every 3 minutes once it's online), and a project that stops answering is recreated
  - opens its tunnel only once every project it was given is up and answering (or after 10 minutes), so a fresh machine never takes traffic it can't serve
  - removes what's no longer wanted
  - routes each replica's name, `<project>-<k>`, through a local Caddy router behind the tunnel (the visitor's address and the https scheme reach the app as `X-Forwarded-*`)
  - keeps going through the ordinary mishaps: a tunnel that won't connect or a router image that won't pull is tried again, a slow `START_CMD` runs in the background, and files a container left behind as root are deleted from a container
- **Self-healing**:
  - A drained machine hands over to a replacement, one machine at a time, without downtime: with a `START_CMD` it starts one for its own slot; without, it restarts its agent.
  - If a pool member dies, members that can start machines start a replacement within about 2 minutes; for a pool whose members can't, whatever watches it starts the slots `POST /api/claim?pool=<name>` returns.
  - On GitHub Actions, the workflow drains each machine 4h15m-5h15m in (at random, so machines that were replaced together drift apart) and stops the agent before the 6-hour limit. A run that ends on its own then asks the control plane what's missing and starts it; if the control plane can't be reached at all, it starts a replacement for its own slot, so the pool outlives a control-plane outage. (A cancelled run doesn't: cancelling the runs is how a pool is stopped by hand.)
  - [`watchdog.yml`](.github/workflows/watchdog.yml) is scheduled every 10 minutes and starts machines if none are left. GitHub runs scheduled workflows late or skips them when it's busy (hours apart has been seen), so it's the backstop, not the mechanism.
  - [`roll.yml`](.github/workflows/roll.yml) restarts the fleet one machine at a time when the agent changes.

## Running the control plane

`control/server.mjs` needs Node 24 (for `node:sqlite`) and `npm install` in `control/` (the `yaml` package). Settings and secrets come from the environment: `PORT` (8920), `DATA_DIR` (where `control.db` lives), `DOMAIN`, `CONTROL_HOST`, `ZONE`, `ACCOUNT_ID`, `POOLS` (default pool sizes, JSON), `MAX_SLOTS`, `ADMIN_PASSWORD`, `JOIN_TOKEN`, and `CF_API_TOKEN` (a token with DNS edit on the zone and Cloudflare Tunnel edit on the account; or `CF_API_KEY` plus `CF_API_EMAIL`). `AGENT_URL` is where machines joining with `install.sh` fetch the agent's code (default: this repo's main branch). `DNS=off` stops it touching DNS (for a copy you're trying things on). It listens on 127.0.0.1 only; a Cloudflare tunnel (`cloudflared tunnel run`, ingress `runners.<domain>` → `http://127.0.0.1:8920`) gives it its name.

The live one runs on the owner's VPS as systemd user units `runner-control.service` (the server, from this repo's checkout) and `runner-control-tunnel.service` (cloudflared), with the settings in `~/.config/runner-control/env`. To deploy a change: pull, then `systemctl --user restart runner-control.service`; the agents keep what's running while it's down for the second that takes. `GET /api/export` and `POST /api/import` (admin password) move the whole state to another server.

## Tests

`control/test/*.sh` run the control plane locally (`test/start.sh`, on port 8911) against a fake Cloudflare API and drive it the way the agents and the web app do; see [`control/test/README.md`](control/test/README.md). The agent has no suite of its own: it was exercised with a fake `docker` and a mock control plane (hung apps, failures that used to end it, leftovers it couldn't delete, join refusals).

## Setup notes

- **Repo secrets:** `JOIN_TOKEN` (the same value as the control plane's `JOIN_TOKEN`). Tunnel tokens come from the control plane.
- **Control plane secrets:** two you use, `ADMIN_PASSWORD` (the fleet owner's master password: locked apps and fleet changes need it; the web app asks for it, and `runnerctl` sends it; `FLEET_PASSWORD` and the header `x-fleet-password`, its old names, still work) and `JOIN_TOKEN` (machines join with it: `install.sh` takes it, and the GitHub repos have it as the secret `JOIN_TOKEN`), plus `CF_API_TOKEN`, which only the control plane uses: a Cloudflare token with Tunnel edit on the account and DNS edit on the zone. App passwords are kept by the control plane.
- **Web app:** changes sent from other sites are refused.
- **History:** until 2026-10-03 the control plane was a Cloudflare Worker with a Durable Object, and the replica URLs went through the Worker. The Workers free plan's 100,000 requests a day (the machines' check-ins alone were 86,400) is why it moved.
- **More machines:** raise a pool's size with `runnerctl pool github <n>` (the web app doesn't show pools) (tunnels are made as needed, up to `MAX_SLOTS`). Change sizes there rather than through the repos' `POOL_SIZE` variable: machines keep re-sending the size they started with, so a change there only takes hold as they're replaced. GitHub Free runs 20 jobs at once, and handovers overlap briefly, so stay at about 18 or fewer. Cloudflare allows 1,000 tunnels per account. The default sizes are the `POOLS` var in `wrangler.toml`.
- **Another GitHub account:** a copy of this repo there (public, so Actions minutes are free) is a pool of its own in the same fleet. Give it the `JOIN_TOKEN` secret and the repo variables `POOL` (the pool's name), `POOL_SIZE` (how many machines it keeps) and `AGENT_REPO=hetp4401/runner`, so its machines run this repo's agent and agent changes need no copying. Disable its `roll` workflow: a roll from here already restarts every pool. `leonardo34554/runner` is set up this way, as pool `leonardo`. Workflow changes do need copying there (merge this repo's main into its main; it isn't a fast-forward).
- **The machines are pinned to `ubuntu-24.04`**, not `ubuntu-latest`, so a new Ubuntu release doesn't change the machines under the fleet; move the pin on purpose. The run logs show only the router's and tunnel's logs, never the apps' (the repos are public).
- **The join token only joins.** A machine started for a slot that's live gets that slot only if the control plane asked for a machine there (a handover's replacement, or a claimed start); otherwise it's given a free slot instead, so the token alone can't take over a live machine's tunnel.
- **Watchdog pausing:** GitHub pauses scheduled workflows in public repos after 60 days without repo activity.

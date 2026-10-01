# runner

Runs projects on a GitHub Actions runner and puts them online through a Cloudflare tunnel.

## Projects

A project is a top-level folder with a `run.sh`, the same idea as `deploy.sh` in my_apps.

```
<project>/
  run.sh       required: any bash, run from inside the folder (docker run -d ..., docker compose up -d, ...)
  port         optional: local port to put online at https://<project>.billybishop4-workers.xyz
  Dockerfile   optional: built as <project>:latest before run.sh runs
```

- Every repository secret is available to `run.sh` as an env var of the same name.
- The folder name becomes the hostname, so stick to `a-z`, `0-9` and `-`.
- Publish the port on the runner (`-p 11470:11470`); the tunnel reaches it at `localhost:<port>`.

Example: [`stremio/`](stremio) puts the Stremio streaming server online at https://stremio.billybishop4-workers.xyz.

## Running

- Every push to `main` starts all projects.
- **Actions → run → Run workflow** does the same, or runs only the folders you list.
- A run lasts just under 6 hours (GitHub's limit). Starting a new run replaces the current one.

## Tunnel

The Cloudflare tunnel `runner` is locally managed: the workflow writes its routes from each project's `port` file, and its token is the `CF_TUNNEL_TOKEN` secret. DNS has `*.billybishop4-workers.xyz` pointing at it, so a new project needs no DNS or Cloudflare change.

# runner

Runs projects on 10 GitHub Actions machines at once and puts each machine online through its own Cloudflare tunnel.

## Projects

A project is a top-level folder with a `run.sh`, the same idea as `deploy.sh` in my_apps. Every machine runs every project.

```
<project>/
  run.sh       required: any bash, run from inside the folder (docker run -d ..., docker compose up -d, ...)
  port         optional: local port to put online at https://<project>-<machine>.billybishop4-workers.xyz
  Dockerfile   optional: built as <project>:latest before run.sh runs
```

- Machine `n` serves `<project>-n`, so `stremio/` is online at https://stremio-1.billybishop4-workers.xyz through https://stremio-10.billybishop4-workers.xyz.
- `run.sh` can read `$MACHINE` (1–10) if a machine needs to do something differently.
- The folder name becomes the hostname, so stick to `a-z`, `0-9` and `-`.
- Publish the port on the runner (`-p 11470:11470`); the tunnel reaches it at `localhost:<port>`.
- To give `run.sh` a repo secret, add it by name to the `env:` of the **Start projects** step in [`run.yml`](.github/workflows/run.yml) (`NAME: ${{ secrets.NAME }}`). Passing all secrets at once gets the workflow flagged as malicious by GitHub.

## Running

- Every push to `main` starts all projects on all 10 machines.
- **Actions → run → Run workflow** does the same, or runs only the folders you list.
- A run lasts just under 6 hours (GitHub's limit). Starting a new run replaces the current one.

## Tunnels and DNS

Machine `n` connects Cloudflare tunnel `runner-n` with the `CF_TUNNEL_TOKEN_n` secret. The tunnels are locally managed: the workflow writes each one's routes from the projects' `port` files. Each machine then creates (or removes) the DNS records for its hostnames with `CF_DNS_TOKEN`, a Cloudflare token that can only edit this domain's DNS. A new project needs no Cloudflare change.

More machines: add the number to `matrix.machine` in `run.yml`, and create tunnel `runner-n` with its token in `CF_TUNNEL_TOKEN_n`. GitHub Free runs up to 20 jobs at once.

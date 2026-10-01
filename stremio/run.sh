#!/usr/bin/env bash
# Stremio streaming server: https://github.com/Stremio/server-docker
# NO_CORS lets any Stremio client (web.stremio.com, apps) use it.
docker run -d --name stremio --restart unless-stopped -p 11470:11470 -e NO_CORS=1 stremio/server:latest

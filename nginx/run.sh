#!/usr/bin/env bash
# Stock nginx, serving its default welcome page.
docker run -d --name nginx --restart unless-stopped -p 8080:80 nginx:latest

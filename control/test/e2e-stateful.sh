#!/bin/bash
# Drives the stateful end-to-end test against the live fleet. Usage: run.sh <phase>
set -u
B=https://control.billybishop4-workers.xyz; T=$(cat ~/.config/runnerctl/token); U=https://notes.billybishop4-workers.xyz
DOH="--doh-url https://1.1.1.1/dns-query"
api() { curl -s -H "Authorization: Bearer $T" -H content-type:application/json "$B/api$1" "${@:2}"; }
state() { api /status | jq -c '.projects[] | select(.name=="notes") | {state, placed:[.placed[] | "\(.machine):\(.replica)\(if .leaving then "(leaving)" else "" end)"], usage, over}'; }
machine() { api /status | jq -r '.projects[] | select(.name=="notes") | .placed[0].machine'; }
waithealthy() { for i in $(seq 1 60); do s=$(api /status | jq -r --argjson m "$1" '.runs[] | select(.live and (.retiring|not) and .machine==$m) | .projects.notes.s // "none"'); [ "$s" = healthy ] && return 0; sleep 10; done; echo "not healthy on $1: $s"; api /status | jq -c --argjson m "$1" '.runs[] | select(.live and .machine==$m) | .projects.notes'; return 1; }
case $1 in
  deploy) ~/.local/bin/runnerctl apply "$(dirname "$0")/e2e-stateful.yml" notes | jq -c '{name, version, stateful, data, storage, placed:[.placed[].machine], error}' ;;
  write) for i in 1 2 3; do curl -s $DOH -X PUT --data-binary "note $i written at $(date +%T)" "$U/files/note$i.txt"; echo; done; head -c 300000 /dev/urandom | base64 > /tmp/e2e-big.txt; curl -s $DOH -X PUT --data-binary @/tmp/e2e-big.txt "$U/files/big.txt"; echo; curl -s $DOH "$U/" ;;
  read) echo "served by: $(curl -s $DOH $U/whoami)"; curl -s $DOH "$U/"; echo; for i in 1 2 3; do curl -s $DOH "$U/files/note$i.txt"; echo; done; curl -s $DOH "$U/files/big.txt" | cmp - /tmp/e2e-big.txt && echo "big.txt intact (400 KB)" ;;
  objects) set -a; . ~/.config/cloudflare.env; . ~/.config/runnerctl/r2.env; set +a; curl -4 -s --aws-sigv4 "aws:amz:auto:s3" --user "$FS_ACCESS_KEY_ID:$FS_SECRET_ACCESS_KEY" "https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com/runner-fs?list-type=2&prefix=notes/" | grep -oE "<Key>[^<]*</Key>|<Size>[^<]*</Size>" | sed 's/<[^>]*>//g' | paste - - | tr '\n' ' '; echo ;;
  state) state ;;
  wait) waithealthy "$2" ;;
  machine) machine ;;
esac

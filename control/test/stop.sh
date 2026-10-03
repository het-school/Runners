# Sourced by the tests, before and after a run: stops the fake Cloudflare API and the control plane, by their ports.
for port in 8911 8790; do for p in $(ss -ltnp | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done; done

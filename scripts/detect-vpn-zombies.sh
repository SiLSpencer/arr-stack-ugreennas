#!/bin/bash
set -euo pipefail
#
# Detect VPN-tunneled containers bound to a network namespace that no longer
# exists — the "zombie" state left behind by a Gluetun *recreate*.
#
# LICENCE: this file remains under CC BY-NC 4.0 (LICENSE-docs), NOT the
# PolyForm Noncommercial licence covering the rest of this repo's code. It is
# adapted from leonardoazeredo/ultimate-arr-stack and was contributed under
# CC BY-NC 4.0; relicensing it needs that author's agreement, requested in
# issue #20. See LICENSE.
#
# ORIGIN: adapted from leonardoazeredo/ultimate-arr-stack, a downstream fork of
# this repo, which published it under this repo's CC BY-NC 4.0 notice. Changed
# here: the dependent list drops that fork's own services and matches this
# stack's four tunneled containers.
#
# A restart is fine: the container ID is unchanged, so dependents keep working.
# A recreate is not. `docker compose up -d` gives Gluetun a NEW container ID
# (even when triggered for an unrelated service, if Gluetun's own config
# drifted), while its dependents stay pinned to the dead one. Docker does not
# clean up the stale reference.
#
# Nothing conventional can see this. `docker ps` shows the dependent Up, its
# healthcheck passes because it queries its own localhost, and deunhealth sees
# a healthy container — while it is completely unreachable from the rest of the
# stack, because the namespace it is joined to is gone.
#
# ⚠️  This script was generated with LLM assistance and human-reviewed.
#     Read and understand it before running. Do not execute scripts you
#     don't understand on your system. It only inspects and reports —
#     it changes nothing.
#
# Usage:
#   ./scripts/detect-vpn-zombies.sh
#
# Exit codes:
#   0 = every VPN-tunneled dependent shares Gluetun's current namespace
#   1 = one or more zombies found, or the check itself could not run
#
# Fix for a detected zombie: docker restart <container>
#
# Worth running after any Gluetun recreate, or from cron:
#   */5 * * * * /path/to/arr-stack/scripts/detect-vpn-zombies.sh || notify "VPN zombie!"

# Must match the services carrying network_mode: "service:gluetun" in
# docker-compose.arr-stack.yml. Sonarr and Radarr are deliberately absent —
# they run on the bridge (docs/MIGRATION-arr-off-vpn.md).
DEPENDENTS=(qbittorrent sabnzbd prowlarr flaresolverr)

GLUETUN_ID=$(docker inspect --format '{{.Id}}' gluetun 2>/dev/null) || {
    echo "ERROR: Could not inspect gluetun — is it running?"
    exit 1
}

zombies=()

for c in "${DEPENDENTS[@]}"; do
    mode=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$c" 2>/dev/null) || continue
    # Only containers joined to another container's namespace can be zombies.
    [[ "$mode" == container:* ]] || continue
    if [[ "$mode" != "container:$GLUETUN_ID" ]]; then
        zombies+=("$c")
    fi
done

if [[ ${#zombies[@]} -gt 0 ]]; then
    echo "ZOMBIE CONTAINERS (bound to a Gluetun that no longer exists): ${zombies[*]}"
    echo "Fix: docker restart ${zombies[*]}"
    exit 1
fi

echo "OK: all VPN-tunneled dependents share Gluetun's current namespace"

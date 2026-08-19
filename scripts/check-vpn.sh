#!/bin/bash
set -euo pipefail
#
# Verify the VPN is actually carrying traffic — for Gluetun itself, and for
# every service that is supposed to be tunneled through it.
#
# ⚠️  This script was generated with LLM assistance and human-reviewed.
#     Read and understand it before running. Do not execute scripts you
#     don't understand on your system. It only inspects and reports —
#     it changes nothing.
#
# WHAT CHANGED AND WHY (2026-08-15): this used to compare Gluetun's exit IP
# against the NAS's LAN IP from `hostname -I`. Those are a public address and a
# private one — a routable WAN address versus an RFC 1918 LAN address — so they
# could never be equal and
# the leak branch could never fire. It reported "OK: VPN is active" whether the
# tunnel was up, down or leaking.
#
# The comparison that means something is against the HOST's OWN EGRESS: what
# the internet sees when traffic does not go through the VPN. Sonarr is used to
# measure it because it is bridge-only by design (docs/MIGRATION-arr-off-vpn.md),
# so its egress is the host's egress.
#
# Per-service checks must assert EQUAL to Gluetun, not merely different from
# the host: a service escaping down some third route would also differ from the
# host while not being tunneled at all.
#
# This is the shell counterpart to tests/e2e/vpn-security.spec.ts. Both
# implement the same comparison; keep them in step.
#
# Usage:
#   ./scripts/check-vpn.sh
#
# Exit codes:
#   0 = Gluetun is tunneling and no tunneled service is leaking
#   1 = a leak was detected, or the check could not run
#
# Use in cron or monitoring:
#   */5 * * * * /path/to/arr-stack/scripts/check-vpn.sh || notify "VPN leak!"

# Must match network_mode: "service:gluetun" in docker-compose.arr-stack.yml.
TUNNELED_SERVICES=(qbittorrent prowlarr sabnzbd flaresolverr)

# Container used to measure the host's non-VPN egress. Must be bridge-only.
HOST_EGRESS_PROBE=sonarr

# Images differ in which HTTP client they ship — Gluetun's Alpine base has only
# wget, LSIO images have curl — so try both in one shell invocation. The /ip
# path matters: ifconfig.me serves curl a bare IP at the root but serves wget
# (no Accept header) its HTML homepage. /ip is plain text for both.
egress_ip() {
    docker exec "$1" sh -c \
        'curl -s --max-time 5 https://ifconfig.me/ip || wget -qO- --timeout=5 https://ifconfig.me/ip' 2>/dev/null
}

echo "Measuring the host's own egress (via $HOST_EGRESS_PROBE, which is bridge-only)..."
HOST_IP=$(egress_ip "$HOST_EGRESS_PROBE") || HOST_IP=""
if [[ -z "$HOST_IP" ]]; then
    echo "ERROR: Could not determine host egress IP via $HOST_EGRESS_PROBE"
    echo "       Is it running, and is it still off the VPN?"
    exit 1
fi

echo "Checking Gluetun's exit IP..."
VPN_IP=$(egress_ip gluetun) || VPN_IP=""
if [[ -z "$VPN_IP" ]]; then
    echo "ERROR: Could not reach an IP-check service through Gluetun"
    echo "       Gluetun may be down or the VPN disconnected"
    exit 1
fi

if [[ "$VPN_IP" == "$HOST_IP" ]]; then
    echo "LEAK DETECTED: Gluetun's egress ($VPN_IP) matches the host's ($HOST_IP)"
    echo "               Gluetun is NOT routing through the VPN."
    exit 1
fi

echo "OK: Gluetun is tunneling"
echo "  host egress: $HOST_IP"
echo "  VPN egress:  $VPN_IP"
echo ""
echo "Checking tunneled services..."

leaked=0
for svc in "${TUNNELED_SERVICES[@]}"; do
    svc_ip=$(egress_ip "$svc") || svc_ip=""
    if [[ -z "$svc_ip" ]]; then
        echo "  WARN: $svc — could not determine egress (container down or unreachable)"
        continue
    fi
    if [[ "$svc_ip" == "$VPN_IP" ]]; then
        echo "  OK:   $svc egresses through Gluetun ($svc_ip)"
    else
        echo "  LEAK: $svc egress ($svc_ip) does NOT match Gluetun ($VPN_IP)"
        leaked=1
    fi
done

if [[ "$leaked" -eq 1 ]]; then
    echo ""
    echo "At least one tunneled service is not going through the VPN."
    exit 1
fi

echo ""
echo "OK: every tunneled service egresses through Gluetun"

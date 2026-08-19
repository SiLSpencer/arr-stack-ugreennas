import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { HOST, requireStackReachable, dockerInspect } from './helpers';

//
// LICENCE: this file remains under CC BY-NC 4.0 (LICENSE-docs), NOT the
// PolyForm Noncommercial licence covering the rest of this repo's code. It is
// adapted from leonardoazeredo/ultimate-arr-stack and was contributed under
// CC BY-NC 4.0; relicensing it needs that author's agreement, requested in
// issue #20. See LICENSE.
//
// ORIGIN: adapted from leonardoazeredo/ultimate-arr-stack, a downstream fork of
// this repo, published under this repo's CC BY-NC 4.0 notice. Changed here: the
// off-NAS gate (see helpers.ts STACK_IS_LOCAL) and this stack's own domains.
//
// Both suites here exist because of specific incidents in this stack's history
// where every conventional signal — `docker ps`, container health, deunhealth —
// reported fine while the thing was broken. A healthcheck that runs INSIDE a
// container cannot see a failure in how that container is reached FROM
// OUTSIDE. These tests look from outside.

const TRAEFIK_LAN_IP = process.env.TRAEFIK_LAN_IP;

test.describe('DNS resolution', () => {
  test('Pi-hole resolves jellyfin.lan to the Traefik macvlan IP', () => {
    test.skip(!TRAEFIK_LAN_IP, 'TRAEFIK_LAN_IP not set in .env.e2e');

    // Pi-hole's DNS is published on ${NAS_IP}:53, so this needs no docker exec
    // and works from a dev machine as well as on the NAS.
    let resolved: string;
    try {
      resolved = execFileSync('dig', [`@${HOST}`, 'jellyfin.lan', '+short'], { encoding: 'utf8', timeout: 5_000 }).trim();
    } catch (err) {
      test.skip(true, `dig unavailable or query failed: ${err}`);
      return;
    }
    expect(resolved).toBe(TRAEFIK_LAN_IP);
  });
});

test.describe('Traefik routing', () => {
  // Guards the 2026-08-01 incident: Traefik recreated through the wrong compose
  // file loses its traefik-lan macvlan and every .lan URL dies, while the
  // container still reports healthy. Only a real request through Traefik's
  // routing logic can see this.
  //
  // The Host header goes straight to TRAEFIK_LAN_IP rather than relying on the
  // runner's own DNS, so a failure here means Traefik, not resolution — the
  // DNS suite above covers that separately.
  for (const [domain, requestPath, expectedMarker] of [
    // Both unauthenticated, so no API key is needed to prove routing works.
    ['jellyfin.lan', '/System/Info/Public', 'Jellyfin'],
    ['sonarr.lan', '/', 'Sonarr'],
  ] as const) {
    test(`${domain} routes end-to-end to its real backend`, async ({ request }) => {
      test.skip(!TRAEFIK_LAN_IP, 'TRAEFIK_LAN_IP not set in .env.e2e');

      const res = await request.get(`http://${TRAEFIK_LAN_IP}${requestPath}`, {
        headers: { Host: domain },
        ignoreHTTPSErrors: true,
      });
      expect(res.status()).toBe(200);
      expect(await res.text()).toContain(expectedMarker);
    });
  }
});

test.describe('Pi-hole port publication', () => {
  test('Pi-hole DNS and web ports are actually published, not silently dropped', () => {
    // Guards the 2026-08-05 incident that took the whole house's DNS down: the
    // NAS reverted to DHCP at boot, Pi-hole's ${NAS_IP}-pinned bindings failed
    // to establish, and the container came up anyway reporting healthy — its
    // own healthcheck digs 127.0.0.1 from inside its netns, which passes
    // happily while nothing outside can reach it. One failed binding drops the
    // container's whole mapping set, which is why the web UI on 8081 went too.
    //
    // Only the actual port mapping shows this.
    requireStackReachable(test.skip);

    const ports = JSON.parse(dockerInspect('pihole', '{{json .NetworkSettings.Ports}}')) as Record<string, unknown>;

    for (const key of ['53/tcp', '53/udp', '80/tcp']) {
      expect(ports[key], `${key} missing from the port map entirely`).toBeTruthy();
      expect(ports[key], `${key} binding is null — port silently unpublished`).not.toBeNull();
    }
  });
});

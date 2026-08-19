import { test, expect } from '@playwright/test';
import {
  DOCKER_TRANSPORT,
  requireStackReachable,
  TUNNELED_SERVICES,
  BRIDGE_SERVICES,
  egressIp,
  dockerInspect,
  dockerLifecycle,
} from './helpers';

//
// LICENCE: this file remains under CC BY-NC 4.0 (LICENSE-docs), NOT the
// PolyForm Noncommercial licence covering the rest of this repo's code. It is
// adapted from leonardoazeredo/ultimate-arr-stack and was contributed under
// CC BY-NC 4.0; relicensing it needs that author's agreement, requested in
// issue #20. See LICENSE.
//
// ORIGIN: adapted from leonardoazeredo/ultimate-arr-stack, a downstream fork of
// this repo, published under this repo's CC BY-NC 4.0 notice. Changed here: the
// off-NAS gate (helpers.ts STACK_IS_LOCAL) and the service lists.
//
// Replaces the old "VPN connectivity" test in stack.spec.ts, which reached
// Sonarr's API and inferred the tunnel was healthy — on a premise that stopped
// being true when Sonarr and Radarr moved off the VPN netns. These compare
// actual egress IPs, which is the only thing that distinguishes "tunneled"
// from "leaking".
//
// They drive `docker exec` against whichever daemon owns the stack — this
// machine's if the containers are here, otherwise the NAS's over SSH (see
// helpers.ts DOCKER_TRANSPORT). They used to require the containers to be
// local, which meant they skipped on every dev machine while the suite still
// exited 0 — a green run that had checked nothing about the VPN.
//
// This is the automated counterpart to scripts/check-vpn.sh; the two implement
// the same comparison and should be kept in step.

test.describe('VPN egress — leak detection', () => {
  test.beforeAll(() => {
    // Surface the transport once, so a run that reaches the NAS over SSH is
    // visibly different from one that quietly checked nothing.
    console.log(`  [vpn-security] docker transport: ${DOCKER_TRANSPORT}`);
  });

  test.beforeEach(() => {
    requireStackReachable(test.skip);
  });

  test("Gluetun's exit IP differs from the NAS's own WAN IP", () => {
    const gluetunIp = egressIp('gluetun');
    // sonarr is bridge-only, so its egress IS the host's WAN egress.
    const hostIp = egressIp('sonarr');
    expect(gluetunIp).toBeTruthy();
    expect(hostIp).toBeTruthy();
    expect(gluetunIp).not.toBe(hostIp);
  });

  for (const service of TUNNELED_SERVICES) {
    test(`${service} egresses through Gluetun, not around it`, () => {
      // Must MATCH Gluetun exactly. "Differs from the NAS IP" would be too
      // weak a test: a service leaking via some third route also differs from
      // the NAS IP while not being tunneled at all.
      const gluetunIp = egressIp('gluetun');
      const serviceIp = egressIp(service);
      expect(gluetunIp).toBeTruthy();
      expect(serviceIp).toBeTruthy();
      expect(serviceIp).toBe(gluetunIp);
    });
  }

  for (const service of BRIDGE_SERVICES) {
    test(`${service} stays OFF the VPN (post-migration regression guard)`, () => {
      // Codifies docs/MIGRATION-arr-off-vpn.md as a permanent check. If one of
      // these ever starts matching Gluetun's IP, something re-tunneled it —
      // probably by adding network_mode: "service:gluetun" back — without
      // updating the migration doc or this test.
      const gluetunIp = egressIp('gluetun');
      const serviceIp = egressIp(service);
      expect(gluetunIp).toBeTruthy();
      expect(serviceIp).toBeTruthy();
      expect(serviceIp).not.toBe(gluetunIp);
    });
  }
});

test.describe('VPN killswitch', () => {
  test('stopping Gluetun blocks qBittorrent egress rather than leaking via a fallback route', async () => {
    requireStackReachable(test.skip);
    test.skip(
      process.env.ALLOW_DISRUPTIVE_TESTS !== '1',
      'set ALLOW_DISRUPTIVE_TESTS=1 to run — it stops the live Gluetun container, interrupting real downloads and searches',
    );
    test.setTimeout(120_000);

    const hostIp = egressIp('sonarr');
    expect(hostIp).toBeTruthy();

    try {
      dockerLifecycle('stop', 'gluetun');

      // A working killswitch means the request FAILS outright. Getting hostIp
      // back here would mean traffic fell through to the NAS's own route —
      // which is precisely the leak this guards against.
      expect(egressIp('qbittorrent')).toBeNull();
    } finally {
      dockerLifecycle('start', 'gluetun');

      // Always leave the stack working, even if the assertion above failed.
      const deadline = Date.now() + 90_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          if (dockerInspect('gluetun', '{{.State.Health.Status}}') === 'healthy') {
            healthy = true;
            break;
          }
        } catch {
          // keep polling
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      expect(healthy).toBeTruthy();
    }
  });
});

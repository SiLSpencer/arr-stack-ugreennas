//
// LICENCE: this file remains under CC BY-NC 4.0 (LICENSE-docs), NOT the
// PolyForm Noncommercial licence covering the rest of this repo's code. It is
// adapted from leonardoazeredo/ultimate-arr-stack and was contributed under
// CC BY-NC 4.0; relicensing it needs that author's agreement, requested in
// issue #20. See LICENSE.
//
// The docker-exec helpers below are adapted from
// leonardoazeredo/ultimate-arr-stack, a downstream fork of this repo, published
// under this repo's CC BY-NC 4.0 notice. Changed here: the off-NAS gate probes
// for a stack container rather than for a working docker CLI (see below).

import { execFileSync } from 'node:child_process';
import * as path from 'path';

export const HOST = process.env.NAS_HOST ?? 'localhost';
export const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

export function screenshotPath(name: string) {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

// ─── Service ports ───────────────────────────────────────────────────────────

export const PORTS = {
  jellyfin: 8096,
  sonarr: 8989,
  radarr: 7878,
  prowlarr: 9696,
  qbittorrent: 8085,
  sabnzbd: 8082,
  seerr: 5055,
  bazarr: 6767,
  pihole: 8081,
} as const;

export function url(service: keyof typeof PORTS, pathStr = '') {
  return `http://${HOST}:${PORTS[service]}${pathStr}`;
}

// ─── VPN topology ────────────────────────────────────────────────────────────
//
// Kept here so the VPN tests and any future check share one definition rather
// than each repeating a list that drifts. Verified against
// docker-compose.arr-stack.yml: these four carry network_mode:
// "service:gluetun". Sonarr and Radarr deliberately do NOT — see
// docs/MIGRATION-arr-off-vpn.md.

export const TUNNELED_SERVICES = ['qbittorrent', 'prowlarr', 'sabnzbd', 'flaresolverr'] as const;
export const BRIDGE_SERVICES = ['sonarr', 'radarr'] as const;

// ─── UI auth helpers ─────────────────────────────────────────────────────────

/** Intercept all requests and add a custom header. Works for SPA auth bypass. */
export async function addHeaderToAllRequests(page: import('@playwright/test').Page, name: string, value: string) {
  await page.route('**/*', async (route) => {
    const headers = { ...route.request().headers(), [name]: value };
    await route.continue({ headers });
  });
}

// ─── Docker-exec helpers ─────────────────────────────────────────────────────
//
// Tests using these need the stack's actual containers on the local docker
// socket, which is only true when the suite runs ON the NAS.
//
// The gate deliberately probes for a STACK CONTAINER, not merely for a working
// docker CLI. A developer Mac running Docker Desktop answers `docker version`
// perfectly well while having no gluetun — so a "is docker available" check
// passes off-NAS and every test below then fails with "No such container".
// Asking whether gluetun is inspectable answers the question actually being
// asked: are the stack's containers reachable from here?

export const STACK_IS_LOCAL = (() => {
  try {
    execFileSync('docker', ['inspect', '--format', '{{.Id}}', 'gluetun'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ─── Reaching the stack from a dev machine ───────────────────────────────────
//
// STACK_IS_LOCAL alone made every VPN test skip whenever the suite ran anywhere
// but the NAS — which is the normal case. `npm run test:e2e` then exited 0 with
// the entire VPN-security file grey, including leak detection and the
// killswitch, and a green run read as "the VPN is fine" while nothing about the
// VPN had been checked. That is the same blind-guard shape those tests exist to
// catch, so it is fixed here rather than documented.
//
// The commands only need A docker daemon that owns the stack — not necessarily
// THIS machine's. So fall back to running them over SSH on the NAS. Requires
// key-based auth already working (BatchMode never prompts); NAS_SSH overrides
// the host.

// Deliberately no default. The NAS's real hostname is private and lives only
// in the untracked .env.e2e — hardcoding one here put it in a public repo, and
// the pre-commit hardcoded-domain check caught it. NAS_SSH overrides; otherwise
// reuse NAS_HOST, which .env.e2e already defines for the HTTP tests.
const NAS_SSH = process.env.NAS_SSH ?? process.env.NAS_HOST ?? '';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/** Single-quote for a POSIX remote shell: ssh re-parses what it is handed. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type DockerTransport = 'local' | 'ssh' | 'none';

export const DOCKER_TRANSPORT: DockerTransport = (() => {
  if (STACK_IS_LOCAL) return 'local';
  if (!NAS_SSH) return 'none';
  try {
    execFileSync(
      'ssh',
      [...SSH_OPTS, NAS_SSH, `docker inspect --format ${shellQuote('{{.Id}}')} gluetun`],
      { stdio: 'ignore', timeout: 20_000 },
    );
    return 'ssh';
  } catch {
    return 'none';
  }
})();

/** True when the stack's containers are drivable from here, however that happens. */
export const STACK_IS_REACHABLE = DOCKER_TRANSPORT !== 'none';

export const STACK_UNREACHABLE_REASON = NAS_SSH
  ? `stack containers not reachable — no local gluetun, and SSH to the configured NAS host ` +
    `could not inspect one either (is SSH enabled on the NAS?). Run the suite on the NAS, or fix SSH.`
  : `stack containers not reachable — no local gluetun, and neither NAS_SSH nor NAS_HOST is set, ` +
    `so there is no NAS to reach over SSH. Set one in .env.e2e, or run the suite on the NAS.`;

// ─── Why unreachable is a FAILURE, not a skip ────────────────────────────────
//
// SSH transport alone was not enough. This NAS drops its SSH service from time
// to time, and the first run after adding SSH support hit exactly that: the
// suite reported "16 passed, 9 skipped" and exited 0 while every VPN leak check
// had been silently dropped. Exit 0 is what CI and a human both read as "the
// VPN is fine", so the skip had to stop being free.
//
// A VPN check that cannot run is an UNVERIFIED result, not a passing one. These
// tests therefore fail when the stack is unreachable. Anyone running the suite
// without a NAS — a fresh clone, someone else's machine — opts out explicitly:
//
//     ALLOW_UNVERIFIED_VPN=1 npm run test:e2e
//
// which restores the old skip behaviour, but as a deliberate choice that is
// visible in the command rather than an accident of the environment.

export const ALLOW_UNVERIFIED_VPN = process.env.ALLOW_UNVERIFIED_VPN === '1';

/**
 * Call at the top of any test that needs the stack's containers.
 *
 * Skips only when the operator has explicitly accepted an unverified VPN;
 * otherwise throws, so the run goes red rather than quietly green.
 */
export function requireStackReachable(skip: (condition: boolean, reason: string) => void): void {
  if (STACK_IS_REACHABLE) return;

  if (ALLOW_UNVERIFIED_VPN) {
    skip(true, `${STACK_UNREACHABLE_REASON} (skipped via ALLOW_UNVERIFIED_VPN=1)`);
    return;
  }

  throw new Error(
    `${STACK_UNREACHABLE_REASON}\n\n` +
    `This is a FAILURE rather than a skip on purpose: a VPN leak check that did ` +
    `not run is an unverified result, and exiting 0 would misreport it as a ` +
    `verified one. Fix the connection, or accept the risk explicitly with ` +
    `ALLOW_UNVERIFIED_VPN=1.`,
  );
}

/** Run a docker subcommand against whichever daemon owns the stack. */
function docker(args: string[], timeoutMs: number): string {
  if (DOCKER_TRANSPORT === 'ssh') {
    const remote = ['docker', ...args].map(shellQuote).join(' ');
    return execFileSync('ssh', [...SSH_OPTS, NAS_SSH, remote], {
      encoding: 'utf8',
      timeout: timeoutMs + 5_000,
    }).trim();
  }
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs }).trim();
}

export function dockerExec(container: string, cmd: string[], timeoutMs = 10_000): string {
  return docker(['exec', container, ...cmd], timeoutMs);
}

export function dockerInspect(container: string, format: string): string {
  return docker(['inspect', '--format', format, container], 10_000);
}

/** Stop/start, for the killswitch test. Separate so the disruptive verbs are greppable. */
export function dockerLifecycle(action: 'stop' | 'start', container: string): void {
  docker([action, container], 30_000);
}

/**
 * Egress IP as seen from outside, fetched from inside `container`.
 *
 * Images ship different HTTP clients — Gluetun's Alpine base has only wget,
 * LSIO images have curl — so try curl then fall back to wget in one shell
 * invocation rather than guessing per container. Uses the `/ip` path
 * specifically: ifconfig.me serves curl a bare IP at the root but serves wget
 * (which sends no Accept header) its full HTML homepage; `/ip` is plain text
 * for both.
 *
 * Returns null on timeout or failure — which is the CORRECT result when a
 * killswitch is doing its job and blocking egress entirely.
 */
export function egressIp(container: string): string | null {
  try {
    // Probe for curl rather than running it and letting it fail: `curl || wget`
    // works, but on the wget-only images the shell writes "sh: curl: not found"
    // to stderr for every single call, which the runner then prints. Seven
    // lines of that per run trains you to ignore this file's output, which is
    // the last thing a leak detector needs.
    return dockerExec(container, [
      'sh', '-c',
      'if command -v curl >/dev/null 2>&1; then ' +
      'curl -s --max-time 5 https://ifconfig.me/ip; ' +
      'else wget -qO- --timeout=5 https://ifconfig.me/ip; fi',
    ], 15_000);
  } catch {
    return null;
  }
}

/**
 * Starts a fresh Juice Shop for a test run, seeded with one admin and one accounting
 * account per Playwright worker so parallel tests never share staff state.
 *
 *   yarn app:up     replace any running copy with a fresh one
 *   yarn app:down   stop and remove it
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASE_URL } from '../src/config';
import { QA_STAFF_SLOTS, qaStaff } from '../src/staff';

// Pinned by digest so every run tests the same build. Override to test another release.
export const IMAGE =
  process.env.JUICE_SHOP_IMAGE ??
  'bkimminich/juice-shop@sha256:877fc77b12d72b42e486eb09b6b1711cc56514306d92006b284e7e7cf076a809';
const NAME = 'juice-shop';
// Passed as NODE_CONFIG: turns off training-mode pop-ups that cover the page in UI tests.
const TEST_CONFIG = {
  challenges: { showSolvedNotifications: false },
  hackingInstructor: { isEnabled: false },
  application: { welcomeBanner: { showOnFirstStart: false } },
};
// Generated each run and git-ignored; mounted over the image's own seed file.
const SEED = resolve('env/users.yml');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/**
 * The image's own users.yml plus the QA staff accounts appended at the end. Copied out of a
 * stopped container because the image is distroless (no shell to run commands in).
 * Juice Shop seeds every user in this file on start, so the accounts exist before any test runs.
 */
function writeSeed(): void {
  const scratch = docker('create', IMAGE);
  try {
    mkdirSync('env', { recursive: true });
    docker('cp', `${scratch}:/juice-shop/data/static/users.yml`, SEED);
  } finally {
    docker('rm', scratch);
  }
  const extra = Array.from({ length: QA_STAFF_SLOTS }, (_, slot) =>
    (['admin', 'accounting'] as const).map((role) => {
      const { local, password } = qaStaff(role, slot);
      return [
        '-',
        `  email: ${local}`,
        `  password: '${password}'`,
        `  key: ${local}`,
        `  role: '${role}'`,
        '  securityQuestion:',
        '    id: 1',
        "    answer: 'qa'",
      ].join('\n');
    }),
  ).flat();
  writeFileSync(SEED, `${readFileSync(SEED, 'utf8').trimEnd()}\n${extra.join('\n')}\n`);
}

/** Polls a cheap public endpoint until the app answers, so tests never start against a booting server. */
export async function waitUntilUp(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/rest/admin/application-version`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Juice Shop did not answer at ${BASE_URL} within ${timeoutMs / 1000}s`);
}

export function down(): void {
  try {
    docker('rm', '-f', NAME);
  } catch {
    // nothing running
  }
}

/** Always a fresh container, so data from an earlier run can't affect this one. */
export async function up(): Promise<void> {
  down();
  writeSeed();
  docker(
    'run', '-d', '--name', NAME, '-p', '3000:3000',
    '-v', `${SEED}:/juice-shop/data/static/users.yml:ro`,
    // Training-mode pop-ups (solved-challenge toasts, tutorial) cover the page and make UI tests flaky.
    '-e', `NODE_CONFIG=${JSON.stringify(TEST_CONFIG)}`,
    IMAGE,
  );
  await waitUntilUp();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'up') await up();
  else if (cmd === 'down') down();
  else throw new Error('usage: juice-shop.ts up|down');
  console.log(`juice-shop ${cmd}`);
}

/**
 * Per-worker staff accounts, seeded by scripts/juice-shop.ts. Playwright's parallelIndex
 * picks the slot, so no two tests running at once share an admin or accounting account.
 * Test-only credentials for a disposable local container; a shared environment would
 * provision these from the CI secret store instead.
 */
/** One admin and one accounting account per slot; must cover the most workers Playwright runs at once. */
export const QA_STAFF_SLOTS = 8;

/** Credentials for one slot. The same formula seeds the container, so both sides agree without a shared file. */
export function qaStaff(role: 'admin' | 'accounting', slot: number): { local: string; email: string; password: string } {
  const local = `qa-${role}-${slot}`;
  return { local, email: `${local}@juice-sh.op`, password: `qa-${role}-${slot}-Passw0rd!` };
}

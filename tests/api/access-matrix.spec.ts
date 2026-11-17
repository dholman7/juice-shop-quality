/**
 * Generated from src/catalog.ts: every endpoint in the top 3 risk areas, called as every role.
 * Allowed roles must succeed; every other role must be refused.
 */
import { test, expect, covers } from '../../src/fixtures';
import { AREAS, ENDPOINTS, allows } from '../../src/catalog';
import { ROLES } from '../../src/config';
import { PROBES, SKIP } from '../../src/probes';

for (const ep of ENDPOINTS) {
  test.describe(`${ep.area} ${AREAS[ep.area]} › ${ep.method} ${ep.path}`, () => {
    for (const role of ROLES) {
      const allowed = allows(ep, role);
      test(`${allowed ? 'allows' : 'refuses'} ${role}`, covers(ep.id, role), async ({ as, request }) => {
        test.skip(SKIP[ep.id]?.includes(role) ?? false, ep.note ?? 'unsafe for shared accounts');

        // Arrange
        const caller = await as(role);
        const owner = async () => (caller.account ? caller : as('customer'));
        const probe = await PROBES[ep.id]({ request, caller, role, owner });

        // Act
        const res = await caller.send(ep.method, probe.path, probe.data);

        // Assert
        const expected = allowed ? probe.ok : (probe.refused ?? [401, 403]);
        expect(expected, `${ep.method} ${probe.path} as ${role} returned ${res.status()}`).toContain(res.status());
      });
    }
  });
}

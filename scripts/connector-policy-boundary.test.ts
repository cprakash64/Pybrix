import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SUPPORT POLICY HAS ONE AUTHORITY (Release 2, Slice 2D), asserted from source.
 *
 * `connector-policy.ts` is a leaf that names `support-v1` and states its two numbers. The cut-face rule and the support
 * validators read it; nothing restates 0.35 or the eight-tolerance floor, because a second statement is the thing that
 * drifts. Checked from source, like the other boundary tests, so the answer never depends on a build existing.
 */
const RUNTIME = join(import.meta.dirname, '..', 'packages', 'geometry-runtime', 'src');
const read = (name: string): string => readFileSync(join(RUNTIME, name), 'utf8');

describe('support-v1 policy authority boundary', () => {
  it('connector-policy.ts is a LEAF: it imports nothing', () => {
    const source = read('connector-policy.ts');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('the manual cut-face rule calls connectorCenters with the policy margin', () => {
    const source = read('split-connectors.ts');
    expect(source).toContain("from './connector-policy'");
    expect(source).toContain('connectorSupportMargin(r, tolerance)');
    expect(source).not.toMatch(/r \* 0\.35/);
  });

  it('0.35 is stated exactly once, in the policy module, among the connector sources', () => {
    for (const file of [
      'split-connectors.ts',
      'automatic-connectors.ts',
      'connector-plan.ts',
      'connector-axial.ts',
      'connector-footprint.ts',
    ])
      expect(read(file), file).not.toMatch(/\b0\.35\b/);
    expect(read('connector-policy.ts').match(/edgeMarginPinRadiusRatio: 0\.35/g)).toHaveLength(1);
  });
});

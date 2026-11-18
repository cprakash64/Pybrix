import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A CONNECTOR'S PHYSICAL SIZE HAS ONE RESOLVER AND ONE CLASSIFIER (Release 2, Stage C03-A), asserted from source.
 *
 * "How many millimetres is one coordinate of this part" and "is this placement a similarity" are each one answer. These facts are
 * invisible in review and each is how the answer would quietly become two: a second `millimetresPerUnit(` beside the planner, a
 * second tolerance beside the classifier, or a validator that learns about units and starts to disagree with the others.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(path, 'utf8');
function productionSources(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('dist-')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}
const everything = [
  ...productionSources(join(ROOT, 'packages')),
  ...productionSources(join(ROOT, 'apps')),
].filter((file) => !file.includes(`${sep}experiments${sep}`));
const rel = (files: readonly string[]): string[] =>
  files.map((file) => relative(ROOT, file)).sort();

describe('there is ONE connector dimension resolver', () => {
  it('forms the millimetres-per-coordinate factor in one module of the engine', () => {
    const forming = everything.filter((file) => read(file).includes('millimetresPerUnit('));
    // the resolver; the shared table that defines it; the page's unit-interpretation DISPLAY helpers (and the Texture workflow's
    // own conversion, which is not a connector and is not touched by this stage)
    expect(rel(forming)).toEqual(
      [
        'apps/web/src/state/unit-interpretation.ts',
        'packages/geometry-runtime/src/connector-dimensions.ts',
        'packages/shared/src/units.ts',
      ].sort(),
    );
  });
  it('is not reached for by the planner, the engine or the worker', () => {
    for (const file of [
      'packages/geometry-runtime/src/automatic-connectors.ts',
      'packages/geometry-runtime/src/split-connectors.ts',
      'packages/geometry-runtime/src/connector-plan.ts',
      'apps/web/src/workers/split-handlers.ts',
    ]) {
      const text = read(join(ROOT, file));
      expect(text, file).not.toMatch(/millimetresPerUnit|MILLIMETRES_PER_UNIT/);
    }
  });
  it('is used by the planner and by the engine entry, and the engine resolves a physical request once', () => {
    expect(read(join(ROOT, 'packages/geometry-runtime/src/automatic-connectors.ts'))).toContain(
      "from './connector-dimensions'",
    );
    const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
    expect(engine.match(/resolveConnectorDimensions\(/g)).toHaveLength(1);
    expect(engine.match(/resolvePhysicalRequest\(/g)).toHaveLength(2); // the definition and its one call
  });
  it('the page converts no connector size: the request carries millimetres', () => {
    const hook = read(join(ROOT, 'apps/web/src/state/use-split-workflow.ts'));
    const body = hook.slice(
      hook.indexOf('export function connectorRequest('),
      hook.indexOf('export function connectorProblemOf('),
    );
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toMatch(
      /millimetresToCoordinates|millimetresPerUnit|coordinatesToMillimetres/,
    );
    expect(body).toContain("kind: 'physical-pin'");
  });
});

describe('there is ONE placement classifier', () => {
  it('is defined once, in mesh-core, and the old worker classifier is gone', () => {
    const definitions = everything.filter((file) =>
      read(file).includes('export function classifyPlacement('),
    );
    expect(rel(definitions)).toEqual(['packages/mesh-core/src/placement.ts']);
    expect(existsSync(join(ROOT, 'apps/web/src/workers/placement-scale.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'apps/web/src/workers/placement-scale.test.ts'))).toBe(false);
    for (const file of everything)
      expect(read(file), relative(ROOT, file)).not.toMatch(/uniformPhysicalScale|placement-scale/);
  });
  it('is the only place the similarity tolerance is applied', () => {
    const classifier = join(ROOT, 'packages/mesh-core/src/placement.ts');
    const using = everything.filter(
      (file) =>
        file !== classifier &&
        read(file).includes('scale * scale * ') &&
        read(file).includes('1e-6'),
    );
    expect(rel(using)).toEqual([]);
    expect(read(classifier)).toContain('PLACEMENT_CLASSIFICATION_TOLERANCE = 1e-6');
    expect(read(classifier).match(/scale \* scale \*/g)).toHaveLength(1);
  });
  it('the worker classifies the placement once and hands the engine a number', () => {
    const handler = read(join(ROOT, 'apps/web/src/workers/split-handlers.ts'));
    expect(handler.match(/classifyPlacement\(/g)).toHaveLength(1);
  });
});

describe('the validators stay physically blind', () => {
  it('footprint, axial depth, support and policy import neither the resolver nor any unit', () => {
    for (const file of [
      'connector-footprint.ts',
      'connector-axial.ts',
      'connector-support.ts',
      'connector-policy.ts',
    ]) {
      const text = read(join(ROOT, 'packages/geometry-runtime/src', file));
      const imports = text
        .split('\n')
        .filter(
          (line) => /^\s*(import|export)\b.*from\s/.test(line) || /^\s*}\s*from\s/.test(line),
        );
      expect(imports.join('\n'), file).not.toMatch(
        /connector-dimensions|shared\/units|LengthUnit|millimetresPerUnit/,
      );
      expect(text, file).not.toMatch(/millimetresPerUnit|mmPerCoordinate|LengthUnit/);
    }
  });
});

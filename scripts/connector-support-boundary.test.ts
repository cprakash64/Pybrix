import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE MATERIAL-SUPPORT RULE HAS ONE IMPLEMENTATION, ONE ORDER AND ONE FEMALE TREE (Release 2, Slice 2D), asserted from source.
 *
 * `support-v1` is a geometric consistency invariant. These facts are not visible in review and each one is how the rule would
 * quietly become two rules: a second validator for the automatic path, a guard Boolean that decides material support in millimetres,
 * a second tree built for the support check, a sampled "approximation", or a check that runs after a Boolean has already cut.
 */
const ROOT = join(import.meta.dirname, '..');
const RUNTIME = join(ROOT, 'packages', 'geometry-runtime', 'src');
const read = (path: string): string => readFileSync(path, 'utf8');
const runtime = (name: string): string => read(join(RUNTIME, name));

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

describe('there is ONE material-support validator and manual and automatic plans share it', () => {
  const everything = [
    ...productionSources(join(ROOT, 'packages')),
    ...productionSources(join(ROOT, 'apps')),
  ].filter((file) => !file.includes(`${sep}experiments${sep}`));
  it('is defined once, and called once, from the connector engine alone', () => {
    const definitions = everything.filter((file) =>
      read(file).includes('export function validateConnectorSupport('),
    );
    expect(definitions.map((file) => relative(ROOT, file))).toEqual([
      join('packages', 'geometry-runtime', 'src', 'connector-support.ts'),
    ]);
    const callers = everything.filter(
      (file) =>
        !file.endsWith('connector-support.ts') && /\bvalidateConnectorSupport\(/.test(read(file)),
    );
    expect(callers.map((file) => relative(ROOT, file))).toEqual([
      join('packages', 'geometry-runtime', 'src', 'split-connectors.ts'),
    ]);
    expect(runtime('split-connectors.ts').match(/validateConnectorSupport\(/g)).toHaveLength(1);
  });
  it('the automatic planner neither validates support nor proves material with a Boolean', () => {
    const planner = runtime('automatic-connectors.ts');
    expect(planner).not.toContain('validateConnectorSupport');
    expect(planner).not.toMatch(/runValidatedBoolean|BooleanBackend|\.operate\(/);
  });
  it('the retired automatic guard-volume check is gone from the engine, and so is the wall it carried', () => {
    const engine = runtime('split-connectors.ts'),
      plan = runtime('connector-plan.ts');
    expect(engine).not.toMatch(/runValidatedBoolean\(\s*backend,\s*'intersection'/);
    expect(engine).not.toMatch(/\bplan\??\.wall\b|Safe connector wall clearance|guard\b/);
    expect(plan).not.toMatch(/readonly wall\b|\bwall:/);
  });
});

describe('the order is: footprint, depth, support, then the first Boolean', () => {
  it('in the pin branch, every check precedes every connector Boolean', () => {
    const engine = runtime('split-connectors.ts'),
      at = (needle: string): number => {
        const index = engine.indexOf(needle);
        expect(index, needle).toBeGreaterThan(-1);
        return index;
      };
    const footprint = at('containFootprints(defined(validatedPlan)'),
      depth = at('validateSocketDepth('),
      support = at('validateConnectorSupport({'),
      firstBoolean = at("runValidatedBoolean(backend, 'union'");
    expect(footprint).toBeLessThan(depth);
    expect(depth).toBeLessThan(support);
    expect(support).toBeLessThan(firstBoolean);
    expect(support).toBeLessThan(at('for (const center of sites)'));
  });
  it('the transform refusal comes before the cut is started', () => {
    const engine = runtime('split-connectors.ts');
    expect(engine.indexOf('UNSUPPORTED_TRANSFORM')).toBeGreaterThan(-1);
    expect(engine.indexOf('Number.isFinite(physicalScale) && physicalScale > 0')).toBeLessThan(
      engine.indexOf('onStage?.(SplitStage.Intersecting)', engine.indexOf('splitOpenSurface(')),
    );
  });
});

describe('the female tree is built once per plan and the male piece has none', () => {
  it('the engine creates ONE shared broadphase and hands it to both checks', () => {
    const engine = runtime('split-connectors.ts');
    expect(engine.match(/createReceivingBroadphase\(/g)).toHaveLength(1);
    expect(engine).toMatch(/validateSocketDepth\([\s\S]{0,200}femaleBroadphase/);
    expect(engine).toMatch(/validateConnectorSupport\(\{[\s\S]{0,200}femaleBroadphase,/);
  });
  it('the support module builds no tree, imports no spatial structure and keeps no per-face index', () => {
    const support = runtime('connector-support.ts');
    expect(support).not.toMatch(/FaceBvh|mesh-core\/spatial|\.build\(|new Map<number, number\[\]>/);
    // the male pass is the checkpointed linear scan
    expect(support).toMatch(/SCAN_CHECKPOINT_FACES/);
    expect(support).toMatch(/throwIfCancelled\(cancellation\)/);
  });
  it('FaceBvh is still imported by exactly the connector axial module among geometry-runtime sources', () => {
    const importers = readdirSync(RUNTIME)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => runtime(name).includes('@cadfixer/mesh-core/spatial'));
    expect(importers.filter((name) => !name.startsWith('hole-fill'))).toEqual([
      'connector-axial.ts',
    ]);
  });
});

describe('the decision is exact: no sampling, no sparse test', () => {
  it('connector-support.ts and the shared predicate use no angles, no random points and no sample grid', () => {
    for (const name of ['connector-support.ts', 'connector-axial.ts']) {
      const source = runtime(name)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source, name).not.toMatch(/Math\.(sin|cos|tan|atan2?|random)\b/);
      expect(source, name).not.toMatch(/\bsamples?\b|voxel|raster/i);
    }
  });
  it('the only entry-cap exclusion is the kernel provenance value', () => {
    const support = runtime('connector-support.ts');
    expect(support.match(/ENTRY_CAP_PROVENANCE/g)?.length).toBeGreaterThanOrEqual(1);
    expect(support).not.toMatch(/z\s*[=<>]=?\s*0|plane\.normal|coplanar\s*\(/);
  });
});

describe('it stays in the geometry worker', () => {
  it('no file outside the worker, the node tests and the runtime package imports the support module', () => {
    for (const file of productionSources(join(ROOT, 'apps', 'web', 'src'))) {
      const relativePath = relative(ROOT, file);
      if (relativePath.includes(`${sep}workers${sep}`)) continue;
      expect(read(file), relativePath).not.toMatch(
        /connector-support|validateConnectorSupport|connector-axial|connector-policy/,
      );
    }
  });
  it('the package index does not export the validator, the axial module or the policy module', () => {
    const index = runtime('index.ts');
    expect(index).not.toMatch(/connector-support|connector-axial|connector-policy/);
  });
  it('the worker passes the placement scale it derived from the canonical transform to the engine, once', () => {
    const handler = readFileSync(
      join(ROOT, 'apps', 'web', 'src', 'workers', 'split-handlers.ts'),
      'utf8',
    );
    expect(handler.match(/classifyPlacement\(sourcePart\.transform\)/g)).toHaveLength(1);
    expect(handler).toContain('classifyPlacement');
    expect(handler).not.toMatch(/uniformPhysicalScale|placement-scale/);
  });
});

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
    expect(engine.match(/resolvePhysicalPin\(/g)).toHaveLength(2); // the definition and its one call
    expect(engine).not.toMatch(/resolvePhysicalRequest/);
  });
  it('is the ONLY definition of the conversion, in both directions, and nothing carries the retired flag', () => {
    const defining = everything.filter((file) =>
      /export function (millimetresToLocal|localToMillimetres|resolveConnectorDimensions)\(/.test(
        read(file),
      ),
    );
    expect(rel(defining)).toEqual(['packages/geometry-runtime/src/connector-dimensions.ts']);
    // the unscaled context is gone: nothing can ask the resolver to skip the placement
    for (const file of everything)
      expect(read(file), relative(ROOT, file)).not.toMatch(/placementScaleApplied/);
  });
  it('the automatic planner converts in neither direction by hand: every length crosses through the resolver module', () => {
    const planner = read(join(ROOT, 'packages/geometry-runtime/src/automatic-connectors.ts'));
    const code = planner
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // no multiplication or division by the factor, and no millimetre literal handed to the conversion
    expect(code).not.toMatch(/[*/]\s*mm\b|\bmm\s*[*/]/);
    expect(code).not.toMatch(/millimetresToLocal\(\s*[0-9]/);
    expect(code).not.toMatch(/span\s*>=\s*[0-9]/);
    // the physical policy is named, in millimetres, in one place
    for (const name of ['wallMinimumMm', 'depthMaximumMm', 'twoPinSpanMm', 'threePinSpanMm'])
      expect(code, name).toContain(`AUTOMATIC_CONNECTOR_LIMITS.${name}`);
  });
  it('the supported units are the six the importer reads, and the resolver takes them from the shared table alone', () => {
    const threeMf = read(join(ROOT, 'packages/file-formats/src/threemf/units.ts'));
    const tokens = [...threeMf.matchAll(/^\s+'([a-z]+)',$/gm)].map((match) => match[1] ?? '');
    const shared = read(join(ROOT, 'packages/shared/src/units.ts'));
    for (const token of tokens) expect(shared, token).toContain(`'${token}'`);
    expect(tokens.sort()).toEqual(['centimeter', 'foot', 'inch', 'meter', 'micron', 'millimeter']);
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
    // Stage C03-C1: the page's validity hint no longer converts a size into the model's units either
    const workflow = read(join(ROOT, 'apps/web/src/state/use-split-workflow.ts'));
    expect(workflow).not.toMatch(/millimetresToCoordinates|coordinatesToMillimetres|unitWord/);
    const hint = workflow.slice(
      workflow.indexOf('export function connectorProblemOf('),
      workflow.indexOf('export function useSplitWorkflow('),
    );
    expect(hint).not.toMatch(/unit/i);
  });
  it("the page restates the engine's physical range as the SAME numbers, held to the resolver's constant", () => {
    const resolver = read(join(ROOT, 'packages/geometry-runtime/src/connector-dimensions.ts'));
    const page = read(join(ROOT, 'apps/web/src/state/split-presentation.ts'));
    expect(resolver).toMatch(/minimum: 0\.01,/);
    expect(resolver).toMatch(/maximum: 1000,/);
    expect(page).toMatch(/value >= \(allowZero \? 0 : 0\.01\) && value <= 1000/);
  });
  it('no production flow sends a coordinate-basis pin: the page builds physical-pin and automatic requests only', () => {
    const callers = everything.filter(
      (file) =>
        file.includes(`${sep}apps${sep}web${sep}src${sep}`) &&
        /connector:\s*\{\s*kind:\s*'pin'/.test(read(file)),
    );
    expect(rel(callers)).toEqual([]);
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
  it('the worker classifies the placement once and hands the engine the WHOLE classification, never a number that has lost its reason', () => {
    const handler = read(join(ROOT, 'apps/web/src/workers/split-handlers.ts'));
    expect(handler.match(/classifyPlacement\(/g)).toHaveLength(1);
    // Stage C03-B: the NaN that used to stand for "no usable placement" is gone from the handler and from the engine's entry
    expect(handler).not.toMatch(/Number\.NaN|physicalScale/);
    const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
    const entry = engine.slice(
      engine.indexOf('export async function splitWithConnectors('),
      engine.indexOf(
        'throwIfCancelled(cancellation);',
        engine.indexOf('export async function splitWithConnectors('),
      ),
    );
    expect(entry).toContain('placement: PlacementClass = IDENTITY_PLACEMENT');
    expect(entry).not.toContain('physicalScale');
  });
  it('every classifier tolerance read, and every sign of a determinant, is in the classifier', () => {
    const classifier = join(ROOT, 'packages/mesh-core/src/placement.ts');
    const reading = everything.filter(
      (file) => file !== classifier && read(file).includes('PLACEMENT_CLASSIFICATION_TOLERANCE'),
    );
    // the index re-exports it for the tests and nothing else reads it
    expect(rel(reading)).toEqual(['packages/mesh-core/src/index.ts']);
  });
});

describe('there is ONE transform refusal mapper (Stage C03-B)', () => {
  const mapper = 'packages/geometry-runtime/src/connector-transform-refusal.ts';
  it('is defined once, and the sentences a person is shown exist nowhere else', () => {
    const definitions = everything.filter((file) =>
      read(file).includes('export function describeTransformRefusal('),
    );
    expect(rel(definitions)).toEqual([mapper]);
    for (const sentence of [
      'Connectors require uniform model scale.',
      "Connectors aren't supported on sheared model placements.",
      'This model placement has an invalid scale.',
      'This model placement is invalid.',
    ]) {
      const holding = everything.filter((file) => read(file).includes(sentence));
      expect(rel(holding), sentence).toEqual([mapper]);
    }
    // the single-sentence message this replaced is gone, with its function
    for (const file of everything)
      expect(read(file), relative(ROOT, file)).not.toMatch(
        /describeTransformFailure|non-uniform scale or a shear: the material/,
      );
  });
  it('the engine words a refusal only through the mapper, and the mapper is exhaustive with no default', () => {
    const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
    expect(engine.match(/describeTransformRefusal\(/g)).toHaveLength(1);
    const text = read(join(ROOT, mapper));
    expect(text).not.toMatch(/\bdefault\s*:/);
    for (const reason of ['NonUniformScale', 'Shear', 'Degenerate', 'Malformed', 'NonFinite'])
      expect(text, reason).toContain(`PlacementRefusal.${reason}`);
  });
  it("neither the automatic planner nor the page re-derives a reason: the planner carries the resolver's", () => {
    const planner = read(join(ROOT, 'packages/geometry-runtime/src/automatic-connectors.ts'));
    expect(planner).not.toMatch(/classifyPlacement\(|PlacementRefusal\./);
    const page = everything.filter(
      (file) =>
        file.includes(`${sep}apps${sep}web${sep}src${sep}`) &&
        !file.includes(`${sep}workers${sep}`),
    );
    for (const file of page)
      expect(read(file), relative(ROOT, file)).not.toMatch(
        /transformReason|describeTransformRefusal/,
      );
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

describe('an unknown unit has one sentence, one typed refusal, and one way in (Stage C03-C2)', () => {
  const mapper = 'packages/geometry-runtime/src/connector-unit-refusal.ts';
  it('the sentence exists in exactly one production file, and the old ones are gone', () => {
    const sentence =
      'This model has no physical units. Set the model units before adding a physical connector.';
    expect(rel(everything.filter((file) => read(file).includes(sentence)))).toEqual([mapper]);
    for (const file of everything)
      expect(read(file), relative(ROOT, file)).not.toMatch(/A known unit is required/);
  });
  it('every unknown-unit refusal of the engine is the one helper, and nothing else files the code', () => {
    const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
    expect(engine.match(/'UNKNOWN_UNITS'/g)?.length ?? 0).toBeLessThanOrEqual(2); // the helper's fallback and the resolver's case label
    expect(engine.match(/throw unknownUnitError\(\)/g)).toHaveLength(4);
    expect(engine.match(/describeUnknownUnitRefusal\(/g)).toHaveLength(1);
    const plan = read(join(ROOT, 'packages/geometry-runtime/src/connector-plan.ts'));
    expect(plan).toContain('describeUnknownUnitRefusal()');
  });
  it('the worker boundary names a physical request only, and the worker refuses anything else before it touches the document', () => {
    const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
    const product = engine.slice(
      engine.indexOf('export type ProductConnectorRequest'),
      engine.indexOf('export interface ProductSplitRequest'),
    );
    expect(product).toContain("kind: 'none'");
    expect(product).toContain("kind: 'automatic'");
    expect(product).toContain('PhysicalPinRequest');
    expect(product).not.toMatch(/'pin'|'dovetail'|SplitConnector/);
    expect(read(join(ROOT, 'packages/geometry-runtime/src/protocol.ts'))).toContain(
      'readonly request: ProductSplitRequest;',
    );
    expect(read(join(ROOT, 'apps/web/src/runtime/geometry-client.ts'))).toContain(
      'request: ProductSplitRequest,',
    );
    const handler = read(join(ROOT, 'apps/web/src/workers/split-handlers.ts'));
    expect(handler.match(/assertProductConnectorRequest\(/g)).toHaveLength(1);
    expect(handler.match(/withStatedUnit\(/g)).toHaveLength(1);
    expect(handler.indexOf('assertProductConnectorRequest(')).toBeLessThan(
      handler.indexOf('residentDocuments.resolvePart('),
    );
    expect(handler.indexOf('withStatedUnit(')).toBeLessThan(
      handler.indexOf('splitWithConnectors('),
    );
  });
  it("the page lists the refusals about what a connector was asked to be by the engine's own legacy codes", () => {
    const plan = read(join(ROOT, 'packages/geometry-runtime/src/connector-plan.ts'));
    const codes = [
      'UNIT_UNKNOWN',
      'UNSUPPORTED_TRANSFORM',
      'DIMENSION_OUT_OF_POLICY',
      'REQUEST_NOT_PHYSICAL',
    ].map((refusal) => {
      const match = new RegExp(`\\[ConnectorRefusal\\.${refusal}\\]: '([A-Z_]+)'`).exec(plan);
      return match?.[1] ?? '';
    });
    const page = read(join(ROOT, 'apps/web/src/state/split-presentation.ts'));
    for (const code of codes) {
      expect(code).not.toBe('');
      expect(page, code).toContain(`'${code}'`);
    }
  });
});

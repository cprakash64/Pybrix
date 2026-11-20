import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE EDITABLE CONNECTOR MODEL HAS ONE INSTALL PATH, ONE VALIDITY RULE AND NO ROUTE OUT OF THE WORKER (Stage EC-1), from source.
 *
 * These facts are invisible in review. A second place that installs a document would skip the release of a retired joint's
 * geometry; a second place that decides whether a joint is usable would one day disagree with the first; and a joint that reached
 * a writer or the page would be geometry in a place the design says it never is.
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
const rel = (files: readonly string[]): string[] => files.map((f) => relative(ROOT, f)).sort();
const under = (prefix: string): string[] =>
  everything.filter((file) => relative(ROOT, file).startsWith(prefix));

describe('a document is installed in one place, and a joint is retired there', () => {
  it('has exactly two writes to the resident map, each preceded by the retirement', () => {
    const source = read(join(ROOT, 'packages/geometry-runtime/src/resident-documents.ts'));
    expect(source.match(/this\.documents\.set\(/g)).toHaveLength(2);
    expect(source.match(/retireDetachedJoints\(/g)).toHaveLength(2);
    for (const call of source.split('this.documents.set(').slice(0, -1))
      expect(call.slice(-400)).toContain('retireDetachedJoints(');
  });

  it('calls the retirement nowhere else', () => {
    const calling = everything.filter((file) => read(file).includes('retireDetachedJoints('));
    expect(rel(calling)).toEqual(
      [
        'packages/geometry-runtime/src/resident-documents.ts',
        'packages/mesh-core/src/joint.ts',
      ].sort(),
    );
  });

  it('builds a joint list in no module but the model and its fixtures', () => {
    const building = everything.filter((file) => /\bjoints\??:/.test(read(file)));
    expect(rel(building)).toEqual(
      [
        'packages/mesh-core/src/document-fixtures.ts',
        'packages/mesh-core/src/document.ts',
        'packages/mesh-core/src/joint.ts',
      ].sort(),
    );
  });
});

describe('whether a joint is usable is decided in one function', () => {
  it('compares a part with a joint built mesh in the model alone', () => {
    const comparing = everything.filter((file) => /(===|!==)\s*[\w.]*builtMesh/.test(read(file)));
    expect(rel(comparing)).toEqual(['packages/mesh-core/src/joint.ts']);
  });
  it('reads the placement a joint was built under in the model alone', () => {
    const reading = everything.filter((file) => read(file).includes('.builtTransform'));
    expect(rel(reading)).toEqual(
      ['packages/mesh-core/src/document-validation.ts', 'packages/mesh-core/src/joint.ts'].sort(),
    );
  });
});

describe('a joint is session state: no writer, reader or page ever holds one', () => {
  const NAMES =
    /\b(ConnectorJoint|JointRecord|JointSide|RetiredJoint|baseMesh|builtMesh|jointRetainedBytes)\b/;
  it('is unknown to every format package', () => {
    for (const file of under('packages/file-formats/')) {
      expect(read(file), rel([file])[0]).not.toMatch(NAMES);
      expect(read(file), rel([file])[0]).not.toMatch(/\.joints\b/);
    }
  });
  it('is unknown to the page: it holds descriptors, never a record', () => {
    for (const file of under('apps/web/src/'))
      expect(read(file), rel([file])[0]).not.toMatch(NAMES);
  });
  it('is unknown to the wire protocol, which carries a descriptor and nothing that holds a mesh', () => {
    const protocol = read(join(ROOT, 'packages/geometry-runtime/src/protocol.ts'));
    expect(protocol).not.toMatch(NAMES);
    expect(protocol).toContain('export interface JointDescriptor');
  });
});

describe('the model is geometry-free and platform-free', () => {
  it('imports nothing from the runtime, the formats, the page, React or Three.js', () => {
    const imports = [
      ...read(join(ROOT, 'packages/mesh-core/src/joint.ts')).matchAll(/from '([^']+)'/g),
    ].map((match) => match[1]);
    expect(imports.sort()).toEqual(
      ['./document', './mesh', './split-limits', '@cadfixer/shared'].sort(),
    );
  });
});

describe('a rebuild goes through the pin stage a split uses, and builds nothing of its own (Stage EC-2)', () => {
  const engine = read(join(ROOT, 'packages/geometry-runtime/src/split-connectors.ts'));
  const rebuild = read(join(ROOT, 'packages/geometry-runtime/src/connector-rebuild.ts'));

  it('has one place that cuts a pin and a socket, and the split and the rebuild both call it', () => {
    expect(engine.match(/male = cylinder\(/g)).toHaveLength(1);
    expect(engine.match(/constructPinConnectors\(/g)).toHaveLength(2); // the definition and the split's call
    expect(rebuild).toContain('constructPinConnectors(');
  });

  it("reaches no validator, Boolean or primitive itself: every one it runs is the stage's", () => {
    for (const name of [
      'runValidatedBoolean',
      'cylinder(',
      'containFootprints',
      'validateSocketDepth',
      'validateConnectorSupport',
      'createReceivingBroadphase',
    ])
      expect(rebuild, name).not.toContain(name);
  });

  it('shares the spacing rule with the resolver instead of restating it', () => {
    expect(engine).toContain('minimumPinSpacing(radius, margin)');
    expect(engine).toContain('pinsTooClose(candidate.point, chosen, minimumSpacing)');
    expect(rebuild).toContain('minimumPinSpacing(');
    expect(rebuild).toContain('pinsTooClose(');
    expect(engine).not.toContain('radius * 2 + margin;');
  });

  it('reads a joint authority in one module, and only through the guard that minted it', () => {
    const reading = everything.filter((file) =>
      /authority\.detail|\{ detail \} = [\w.]*authority/.test(read(file)),
    );
    expect(rel(reading)).toEqual(['packages/geometry-runtime/src/connector-rebuild.ts']);
    expect(rebuild).toContain('MINTED.has(detail)');
  });

  it('is geometry-runtime code: no React, Three.js, page or format import', () => {
    for (const line of rebuild
      .split('\n')
      .filter((l) => l.startsWith('import') || l.startsWith('} from'))) {
      expect(line).not.toMatch(/react|three|apps\/|file-formats/);
    }
  });
});

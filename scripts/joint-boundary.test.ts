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

  it('calls the retirement only where a document is about to be installed or reported', () => {
    const calling = everything.filter((file) => read(file).includes('retireDetachedJoints('));
    // the definition; the install path; and each place that builds a successor document and REPORTS from it before the swap, so what it
    // reports is the document as it will be held
    expect(rel(calling)).toEqual(
      [
        'apps/web/src/workers/hole-fill-workflow-handlers.ts',
        'apps/web/src/workers/repair-handlers.ts',
        'packages/geometry-runtime/src/geometry-edit.ts',
        'packages/geometry-runtime/src/resident-documents.ts',
        'packages/geometry-runtime/src/split-candidates.ts',
        'packages/mesh-core/src/joint.ts',
      ].sort(),
    );
  });

  it('every module that installs a successor document retires first, or installs a document whose joints are its own', () => {
    const installing = everything.filter((file) =>
      /(?:residentDocuments|this\.resident)\.replace\(/.test(read(file)),
    );
    // joint-edits.ts installs a candidate whose only joint change is the successor of a joint that was attached a moment earlier
    const ownJoints = ['packages/geometry-runtime/src/joint-edits.ts'];
    for (const file of installing)
      if (!ownJoints.includes(relative(ROOT, file)))
        expect(read(file), relative(ROOT, file)).toContain('retireDetachedJoints(');
  });

  it('builds a joint list in the model, its fixtures and the two modules that create or replace a joint', () => {
    // a `joints:` field that carries DESCRIPTORS to the page is not a record list, and is the only other one there is
    // the page's own `joints` slice holds descriptors, and the record names are kept out of it by the test below
    const building = everything
      .filter(
        (file) =>
          !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}`) ||
          relative(ROOT, file).includes(`${sep}workers${sep}`),
      )
      .filter((file) =>
        read(file)
          .split('\n')
          .some(
            (line) => /\bjoints\??:/.test(line) && !/JointDescriptor|describeJoints/.test(line),
          ),
      );
    expect(rel(building)).toEqual(
      [
        'packages/geometry-runtime/src/joint-edits.ts',
        'packages/geometry-runtime/src/split-candidates.ts',
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
  it('reads the placement a joint was built under in the model, and to tell the page where a pin is', () => {
    const reading = everything.filter((file) => read(file).includes('.builtTransform'));
    // the document gate checks it is usable, the attachment compares it, and the descriptor applies it to report a pin's place in the
    // scene: a projection that decides nothing. So does the one module that reads a cut, to say where the cut's axes point in the scene
    // (Stage EC-8): labels only.
    expect(rel(reading)).toEqual(
      [
        'packages/geometry-runtime/src/connector-rebuild.ts',
        'packages/geometry-runtime/src/joint-descriptors.ts',
        'packages/mesh-core/src/document-validation.ts',
        'packages/mesh-core/src/joint.ts',
      ].sort(),
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
    // the page is everything under `apps/web/src` that is not the worker, which owns the geometry and so names the records it retires
    const workers = `apps${sep}web${sep}src${sep}workers${sep}`;
    for (const file of under('apps/web/src/').filter((f) => !relative(ROOT, f).startsWith(workers)))
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

describe('the page keeps no record of a connector (Stage EC-4)', () => {
  const page = under('apps/web/src/').filter(
    (file) => !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}workers${sep}`),
  );

  it('has no connector-pair field, type or migration of its own', () => {
    for (const file of page) {
      const text = read(file);
      expect(text, rel([file])[0]).not.toMatch(
        /\.connectorPairs\b|\bconnectorPairs:|connectorPairIds|AssemblyConnectorPair/,
      );
    }
  });

  it('asks the worker for the list in one place, once for each revision it holds', () => {
    const asking = page.filter((file) => read(file).includes('.listJoints('));
    expect(rel(asking)).toEqual(['apps/web/src/state/use-joint-sync.ts']);
  });

  it('reads the connectors only through the projection, which holds the staleness rule', () => {
    const reading = page.filter((file) => /\bconnectorPairsOf\(/.test(read(file)));
    expect(rel(reading)).toEqual(
      [
        'apps/web/src/components/ConnectorList.tsx',
        'apps/web/src/components/ViewportPanel.tsx',
        'apps/web/src/state/joint-presentation.ts',
        'apps/web/src/state/use-split-workflow.ts',
        'apps/web/src/state/workspace-store.ts',
      ].sort(),
    );
    for (const file of reading)
      if (!relative(ROOT, file).endsWith('joint-presentation.ts'))
        expect(read(file), rel([file])[0]).toContain('currentJoints(');
  });
});

describe("a connector is changed in one place, by the worker, on the caller's stated guards (Stage EC-5)", () => {
  const page = under('apps/web/src/').filter(
    (file) => !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}workers${sep}`),
  );

  it('proposes, applies and releases an edit in the editor hook alone, and never from a component', () => {
    const calling = page.filter((file) =>
      /\.(?:proposeJointEdit|commitJointEdit|discardJointEdit)\(/.test(read(file)),
    );
    expect(rel(calling)).toEqual(['apps/web/src/state/use-connector-edit.ts']);
  });

  it('adopts the result of an edit through the store, from the editor hook alone', () => {
    const adopting = page.filter((file) => read(file).includes('.applyJointEditResult('));
    expect(rel(adopting)).toEqual(['apps/web/src/state/use-connector-edit.ts']);
  });

  it('states the digest it started from when it applies, and sends a pin its own name and place', () => {
    const hook = read(join(ROOT, 'apps/web/src/state/use-connector-edit.ts'));
    expect(hook).toContain("expectedSpecDigest: joint.specDigest ?? ''");
    expect(hook).toContain('pinId: pin.pinId');
    expect(hook).toMatch(/u: pin\.u,\s*v: pin\.v,/);
  });

  it("sends a connector's place only as the pair of numbers the person set, never as a site, a frame or a point of the model", () => {
    const hook = read(join(ROOT, 'apps/web/src/state/use-connector-edit.ts'));
    expect(hook).not.toMatch(/siteOnInterface|interfaceCoordinates|\blocal:|\bcenter\b/);
  });
});

describe('a connector is placed by looking at the cut, and the picture judges nothing (Stage EC-6)', () => {
  const page = under('apps/web/src/').filter(
    (file) => !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}workers${sep}`),
  );
  const face = read(join(ROOT, 'apps/web/src/components/CutFace.tsx'));
  const arithmetic = read(join(ROOT, 'apps/web/src/state/cut-face-view.ts'));

  it('draws the cut from the worker description alone, importing no runtime, worker or model value', () => {
    for (const source of [face, arithmetic])
      for (const line of source.split('\n').filter((l) => /^import |^} from /.test(l)))
        expect(line).not.toMatch(/runtime\/|workers\/|@cadfixer\/(?!geometry-runtime)|three/);
    // the only runtime package symbol either imports is a TYPE
    expect(face).toMatch(/import type \{ JointOutline \} from '@cadfixer\/geometry-runtime'/);
    expect(arithmetic).toMatch(/import type \{ JointOutline \} from '@cadfixer\/geometry-runtime'/);
  });

  it('does not keep a connector inside the outline or away from another: the worker alone judges a place', () => {
    for (const source of [face, arithmetic].map((text) =>
      text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
    ))
      expect(source).not.toMatch(
        /pointInPolygon|insideOutline|minimumPinSpacing|pinsTooClose|\bclamp/i,
      );
  });

  it('reads the cut face description in the editor and the hook alone', () => {
    const reading = page.filter((file) => /\.cutFace\b/.test(read(file)));
    expect(rel(reading)).toEqual(
      [
        'apps/web/src/components/ConnectorEditor.tsx',
        'apps/web/src/state/use-connector-edit.ts',
      ].sort(),
    );
  });

  it('describes the outline in the one module that reads the cut, and nowhere else', () => {
    const describing = everything.filter(
      (file) =>
        read(file).includes('describeCutOutline(') || read(file).includes('describeCutAxes('),
    );
    expect(rel(describing)).toEqual(
      [
        'packages/geometry-runtime/src/connector-rebuild.ts',
        'packages/geometry-runtime/src/joint-descriptors.ts',
      ].sort(),
    );
  });
});

describe('the connector editor is one controller drawn in one workspace at a time (Stage EC-7)', () => {
  const page = under('apps/web/src/').filter(
    (file) => !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}workers${sep}`),
  );

  it('runs the editor hook once, in the controllers provider, so a draft belongs to the application and not to a workspace', () => {
    const calling = page.filter((file) => /\buseConnectorEdit\(/.test(read(file)));
    expect(rel(calling)).toEqual(
      [
        'apps/web/src/state/use-connector-edit.ts',
        'apps/web/src/state/workflow-controllers.tsx',
      ].sort(),
    );
  });

  it('mounts the editor through its slot, once in each workspace and nowhere else', () => {
    const mounting = page.filter((file) => /<ConnectorEditorSlot\b/.test(read(file)));
    expect(rel(mounting)).toEqual(
      [
        'apps/web/src/components/ConvertWorkspace.tsx',
        'apps/web/src/components/RepairWorkspace.tsx',
        'apps/web/src/components/SplitWorkspace.tsx',
        'apps/web/src/components/TextureWorkspace.tsx',
      ].sort(),
    );
    const editor = read(join(ROOT, 'apps/web/src/components/ConnectorEditor.tsx'));
    expect(editor).toMatch(
      /\(selectedWorkflow \?\? DEFAULT_WORKSPACE\) !== workflow\) return null/,
    );
    // the editor itself is never mounted directly by a workspace: a second copy would be a second set of ids
    const direct = page.filter(
      (file) =>
        /<ConnectorEditor\b(?!Slot)/.test(read(file)) &&
        !relative(ROOT, file).endsWith('ConnectorEditor.tsx'),
    );
    expect(rel(direct)).toEqual([]);
  });
});

describe('the axes of a cut are named in one place and only read by the editor (Stage EC-8)', () => {
  const page = under('apps/web/src/').filter(
    (file) => !relative(ROOT, file).startsWith(`apps${sep}web${sep}src${sep}workers${sep}`),
  );
  it('reads the axes of a cut in the editor alone, and names them in one presentation module', () => {
    const reading = page.filter((file) => /\.cutFace\??\.axes\b/.test(read(file)));
    expect(rel(reading)).toEqual(['apps/web/src/components/ConnectorEditor.tsx']);
    const naming = page.filter((file) => /\bnameDirection\(/.test(read(file)));
    expect(rel(naming)).toEqual(['apps/web/src/state/cut-axes-presentation.ts']);
  });
  it('lets the labels decide nothing: the presentation imports no runtime value and the picture only draws what it is given', () => {
    const presentation = read(join(ROOT, 'apps/web/src/state/cut-axes-presentation.ts'));
    for (const line of presentation.split('\n').filter((l) => l.startsWith('import ')))
      expect(line.startsWith('import type ')).toBe(true);
    expect(read(join(ROOT, 'apps/web/src/components/CutFace.tsx'))).not.toMatch(
      /cut-axes-presentation/,
    );
  });
});

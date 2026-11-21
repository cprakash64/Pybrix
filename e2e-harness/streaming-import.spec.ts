import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  buildZip,
  tetrahedronMesh,
  threeMf,
  threeMfLarge,
  threeMfNestedComponents,
  threeMfOverEntryCeiling,
  threeMfProductionExtension,
  threeMfProductionLarge,
  threeMfSharedPlacements,
  threeMfWithMaterial,
  threeMfWithTexture,
  threeMfZip64Production,
  modelXml,
  toZip64,
} from '../e2e/format-fixtures';
import {
  digest,
  Fixture,
  loadFixture,
  openHarness,
  readScene,
  readState,
  type DocumentDigest,
  type HarnessState,
} from './harness';
import { openInspector } from '../e2e/inspector';

/**
 * STAGE 6E-A2 — STREAMED 3MF INGESTION THROUGH THE WHOLE PIPELINE.
 *
 * The unit suites prove the streamed READER equals the buffered one. What only
 * a browser can prove is the rest of the import: the real worker, the real
 * `model/import` handler — identification, mesh gate, document gate, resource
 * gate, render snapshot, resident commit — the page's store, the viewport and
 * the automatic analysis, with the streamed reader in front of them.
 *
 * THE HARNESS CHOOSES THE READER, THE PRODUCT CANNOT. `setIngestion` posts a
 * harness-only message to the harness worker, which rebuilds its real-import
 * handler with `createModelImportHandler` — the production handler's own
 * factory. The shipped worker has no listener for that message and registers
 * only `PRODUCTION_IMPORT_CONFIG`; a boundary test holds that.
 */

type Mode = 'buffered' | 'streaming' | 'auto';

interface Chosen {
  readonly name: string;
  readonly buffer: Buffer;
}

async function setIngestion(page: Page, mode: Mode, maxEntryBytes?: number): Promise<void> {
  await page.evaluate(
    async (request: { readonly mode: Mode; readonly maxEntryBytes?: number }) => {
      const harness = window.cadfixerHarness;
      if (harness === undefined) throw new Error('harness bridge is missing');
      await harness.setIngestion(request.mode, request.maxEntryBytes);
    },
    { mode, ...(maxEntryBytes === undefined ? {} : { maxEntryBytes }) },
  );
}

async function choose(page: Page, file: Chosen): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: file.name,
    mimeType: 'application/octet-stream',
    buffer: file.buffer,
  });
}

async function statusText(page: Page): Promise<string> {
  return (await page.getByTestId('status-list').textContent()) ?? '';
}

/** Imports `file` and waits until the store, the viewport AND analysis settle. */
async function importSettled(page: Page, file: Chosen): Promise<HarnessState> {
  const before = await readState(page);
  await choose(page, file);
  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return state.loaded && state.documentId !== before.documentId;
      },
      { timeout: 180_000 },
    )
    .toBe(true);
  const loaded = await readState(page);
  await expect
    .poll(async () => (await readScene(page)).modelRevision, { timeout: 60_000 })
    .toBe(loaded.workspaceRevision);
  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 120_000 })
    .toMatch(/^(ready|failed|cancelled|unavailable)$/);
  // A small part is also checked for self-intersection automatically; wait for
  // that report too, or two imports are compared at different moments.
  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return (
          state.selfIntersectionBand !== 'AUTO_ELIGIBLE' ||
          (state.selfIntersectionStatus !== undefined &&
            state.selfIntersectionReportPartId === state.activePartId)
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  await expect(page.getByTestId('import-progress')).toHaveCount(0);
  return readState(page);
}

/**
 * Clicks Cancel FROM INSIDE THE PAGE the moment the worker reports `phase`.
 *
 * A Playwright poll can miss a phase that lasts a few milliseconds; a
 * MutationObserver runs in the same task as the render that set it.
 */
async function cancelOnPhase(page: Page, phase: string, occurrence = 1): Promise<void> {
  await page.evaluate(
    (target: { readonly phase: string; readonly occurrence: number }) => {
      let seen = 0;
      let last: string | null = null;
      const observer = new MutationObserver(() => {
        const progress = document.querySelector('[data-testid="import-progress"]');
        const current = progress?.getAttribute('data-phase') ?? null;
        if (current === last) return;
        last = current;
        if (current !== target.phase) return;
        seen += 1;
        if (seen < target.occurrence) return;
        observer.disconnect();
        document.querySelector<HTMLButtonElement>('[data-testid="cancel-import"]')?.click();
      });
      observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    },
    { phase, occurrence },
  );
}

/** Everything but the identities every import mints afresh. */
function comparableState(state: HarnessState): Partial<HarnessState> {
  const { documentId, revision, workspaceRevision, loadCount, ...rest } = state;
  void documentId;
  void revision;
  void workspaceRevision;
  void loadCount;
  return rest;
}

/**
 * The same file imported under EVERY ingestion mode — Stage 6E-A3 added the
 * third. `auto` is what the product registers, so a comparison that omitted it
 * would prove the two forced paths agree and say nothing about the shipped one.
 */
async function importEveryWay(
  page: Page,
  file: Chosen,
): Promise<
  Record<Mode, { readonly state: Partial<HarnessState>; readonly digest: DocumentDigest }>
> {
  const out: Partial<
    Record<Mode, { readonly state: Partial<HarnessState>; readonly digest: DocumentDigest }>
  > = {};
  for (const mode of ['buffered', 'streaming', 'auto'] as const) {
    await setIngestion(page, mode);
    const state = await importSettled(page, file);
    out[mode] = { state: comparableState(state), digest: await digest(page, state) };
  }
  return out as Record<
    Mode,
    { readonly state: Partial<HarnessState>; readonly digest: DocumentDigest }
  >;
}

/* --------------------------------------------------------------- fixtures -- */

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const ALTERNATIVES_NS =
  'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** The family's leaf placements: the assembly's three components and two items. */
const FAMILY_PARTS = 5;

/**
 * Root → children A, B, C, one of them placed three times with transforms, a
 * CJK object name, and every child a separate model part. The shape the A2
 * brief names: multi-part, repeated reference, transforms, several parts.
 */
function productionFamily(): Buffer {
  const child = (
    id: string,
    scale: number,
    name: string,
  ): string => `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}"><resources><object id="${id}" type="model" name="${name}">${tetrahedronMesh(scale)}</object></resources><build/></model>`;
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">
 <resources>
  <object id="9" type="model" name="Assembly 組立"><components>
   <component p:path="/3D/Objects/a.model" objectid="1"/>
   <component p:path="/3D/Objects/b.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
   <component p:path="/3D/Objects/c.model" objectid="4" transform="0 1 0 -1 0 0 0 0 1 0 20 0"/>
  </components></object>
 </resources>
 <build>
  <item objectid="9"/>
  <item objectid="1" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 0 0 30"/>
  <item objectid="1" p:path="/3D/Objects/a.model" transform="2 0 0 0 2 0 0 0 2 0 0 60"/>
 </build>
</model>`;
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: '3D/3dmodel.model', content: root },
    { name: '3D/Objects/a.model', content: child('1', 10, 'Part A') },
    { name: '3D/Objects/b.model', content: child('1', 7, 'Part B — 部品') },
    { name: '3D/Objects/c.model', content: child('4', 5, 'Part C') },
  ]);
}

function cjkNamed(triangles: number): Buffer {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let index = 0; index < triangles; index += 1) {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    const base = index * 3;
    vertices.push(
      `<vertex x="${x.toFixed(3)}" y="${y.toFixed(3)}" z="0"/><vertex x="${(x + 0.4).toFixed(3)}" y="${y.toFixed(3)}" z="0"/><vertex x="${x.toFixed(3)}" y="${(y + 0.4).toFixed(3)}" z="0"/>`,
    );
    faces.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="模型 ${String(triangles)}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`,
    }),
  );
}

/** A large single part that becomes malformed, unsafe or unsupported LATE. */
function lateFailure(kind: 'malformed' | 'entity' | 'alternatives', triangles: number): Buffer {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let index = 0; index < triangles; index += 1) {
    const x = (index % 512) * 0.5;
    const y = Math.floor(index / 512) * 0.5;
    const base = index * 3;
    vertices.push(
      `<vertex x="${x.toFixed(3)}" y="${y.toFixed(3)}" z="0"/><vertex x="${(x + 0.4).toFixed(3)}" y="${y.toFixed(3)}" z="0"/><vertex x="${x.toFixed(3)}" y="${(y + 0.4).toFixed(3)}" z="0"/>`,
    );
    faces.push(
      `<triangle v1="${String(base)}" v2="${String(base + 1)}" v3="${String(base + 2)}"/>`,
    );
  }
  const mesh = `<mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh>`;
  const late =
    kind === 'alternatives'
      ? `<object id="2" type="model">${tetrahedronMesh()}<alt:alternatives/></object>`
      : '';
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}" xmlns:alt="${ALTERNATIVES_NS}">
 <resources><object id="1" type="model">${mesh}</object>${late}</resources>
 <build><item objectid="1"/></build>
</model>${kind === 'malformed' ? '<broken' : kind === 'entity' ? '<!ENTITY x "y">' : ''}`;
  return threeMf(model);
}

/* ------------------------------------------------------------------ tests -- */

test.describe('6E-A2: a streamed import is the same import, through the whole pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  const cases: readonly Chosen[] = [
    { name: 'dense.3mf', buffer: threeMfLarge(20_000) },
    { name: 'family.3mf', buffer: productionFamily() },
    { name: 'family-zip64.3mf', buffer: toZip64(productionFamily()) },
    { name: 'zip64.3mf', buffer: threeMfZip64Production() },
    { name: 'production.3mf', buffer: threeMfProductionExtension() },
    { name: 'large-children.3mf', buffer: threeMfProductionLarge(3, 20_000) },
    { name: 'shared.3mf', buffer: threeMfSharedPlacements(10) },
    { name: 'nested.3mf', buffer: threeMfNestedComponents() },
    { name: 'material.3mf', buffer: threeMfWithMaterial() },
    { name: 'texture.3mf', buffer: threeMfWithTexture() },
    { name: 'cjk.3mf', buffer: cjkNamed(5_000) },
  ];

  for (const file of cases) {
    test(`${file.name}: document, source facts, render snapshot and analysis all match`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      // BUFFERED IS THE ORACLE: v0.2.0's path is what the product produced
      // before Stage 6E, so both newer paths are compared against it rather
      // than against each other.
      const every = await importEveryWay(page, file);
      expect(every.streaming.state).toEqual(every.buffered.state);
      expect(every.streaming.digest).toEqual(every.buffered.digest);
      expect(every.auto.state).toEqual(every.buffered.state);
      expect(every.auto.digest).toEqual(every.buffered.digest);
      expect(every.buffered.state.partCount).toBeGreaterThan(0);
    });
  }

  test('A3-R19: exporting writes the same STL, OBJ and 3MF bytes under every ingestion mode', async ({
    page,
  }) => {
    /*
     * STAGE 6E-A3 ADDED `auto` TO THIS COMPARISON. Exporting is a read of the
     * resident document, so if two ingestion paths produce the same document
     * they must produce the same bytes — and the artifact is validated by being
     * read back, so a difference would surface twice. The product now registers
     * `auto`, which makes it the mode a user's export actually goes through;
     * comparing only the two forced modes would have stopped describing the
     * shipped path.
     */
    test.setTimeout(300_000);
    const file: Chosen = { name: 'family.3mf', buffer: productionFamily() };
    const hashes: Record<Mode, string[]> = { buffered: [], streaming: [], auto: [] };
    for (const mode of ['buffered', 'streaming', 'auto'] as const) {
      await setIngestion(page, mode);
      await importSettled(page, file);
      await openInspector(page);
      await page.getByTestId('open-convert').click();
      await expect(page.getByTestId('convert-workspace')).toBeVisible();
      for (const target of ['stl', 'obj', '3mf'] as const) {
        await page.getByTestId(`convert-target-${target}`).check();
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByTestId('convert-export').click();
        const saved = await (await download).path();
        await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
        hashes[mode].push(
          `${target}:${createHash('sha256').update(readFileSync(saved)).digest('hex')}`,
        );
      }
    }
    expect(hashes.buffered).toHaveLength(3);
    expect(hashes.streaming).toEqual(hashes.buffered);
    expect(hashes.auto).toEqual(hashes.buffered);
  });
});

test.describe('6E-A2: a streamed import that fails commits nothing and leaves the worker usable', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  const failures = [
    ['late malformed token, found in the element pass', 'malformed', /malformed XML/i],
    ['late ENTITY, found in the security pass', 'entity', /XML entities/i],
    [
      'late unsupported alternatives element',
      'alternatives',
      /more than one version of the same object/i,
    ],
  ] as const;

  for (const [label, kind, message] of failures) {
    test(`${label}: no new document, no element pass where security refused`, async ({ page }) => {
      test.setTimeout(300_000);
      const open = await loadFixture(page, Fixture.SinglePart);
      const openDigest = await digest(page, open);
      await setIngestion(page, 'streaming');

      // Record every phase the worker reports, straight from the DOM attribute.
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __phases: string[] }).__phases = seen;
        new MutationObserver(() => {
          const phase = document
            .querySelector('[data-testid="import-progress"]')
            ?.getAttribute('data-phase');
          if (phase !== null && phase !== undefined && seen.at(-1) !== phase) seen.push(phase);
        }).observe(document.body, { subtree: true, attributes: true, childList: true });
      });

      await choose(page, { name: `${kind}.3mf`, buffer: lateFailure(kind, 150_000) });
      await expect(page.getByTestId('status-list')).toContainText(message, { timeout: 180_000 });
      await expect(page.getByTestId('import-progress')).toHaveCount(0);

      const after = await readState(page);
      expect(after.documentId).toBe(open.documentId);
      expect(after.revision).toBe(open.revision);
      expect(await digest(page, after)).toEqual(openDigest);
      await expect(page.getByTestId('session-lost')).toHaveCount(0);

      const phases = await page.evaluate(
        () => (window as unknown as { __phases: string[] }).__phases,
      );
      if (kind === 'entity') {
        // The element pass never began: its handlers — which report "parsing
        // model" as they are created — were never created.
        expect(phases).not.toContain('parsing model');
      }

      // The worker is healthy: the next streamed import lands.
      const next = await importSettled(page, { name: 'next.3mf', buffer: productionFamily() });
      expect(next.partCount).toBe(FAMILY_PARTS);
    });
  }

  const cancelPoints = [
    ['in the security pass of the root', 'decompressing', 1],
    ['in the element pass of the root', 'parsing model', 1],
    ['in a CHILD model part', 'decompressing', 2],
    ['after every model part, before the commit', 'building document', 1],
  ] as const;

  for (const [label, phase, occurrence] of cancelPoints) {
    test(`cancel ${label}: cancelled, nothing committed, next import lands`, async ({ page }) => {
      test.setTimeout(300_000);
      const open = await loadFixture(page, Fixture.SinglePart);
      await setIngestion(page, 'streaming');
      await cancelOnPhase(page, phase, occurrence);
      await choose(page, { name: 'large.3mf', buffer: threeMfProductionLarge(4, 150_000) });
      await expect(page.getByTestId('status-list')).toContainText(
        'Import of large.3mf was cancelled.',
        { timeout: 180_000 },
      );
      await expect(page.getByTestId('import-progress')).toHaveCount(0);
      const after = await readState(page);
      expect(after.documentId).toBe(open.documentId);
      expect(await statusText(page)).not.toMatch(/Loaded large\.3mf/);
      await expect(page.getByTestId('session-lost')).toHaveCount(0);
      const next = await importSettled(page, { name: 'next.3mf', buffer: productionFamily() });
      expect(next.partCount).toBe(FAMILY_PARTS);
    });
  }

  for (const fraction of [0.1, 0.5, 0.9]) {
    test(`cancel at ~${String(fraction * 100)}% of a measured streamed import`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      await setIngestion(page, 'streaming');
      const file: Chosen = { name: 'timed.3mf', buffer: threeMfLarge(300_000) };
      // The reader reports phases, not bytes, to the page, so the position is
      // a fraction of this machine's own uncancelled duration.
      const started = Date.now();
      await importSettled(page, file);
      const whole = Date.now() - started;
      const open = await readState(page);

      await choose(page, { ...file, name: 'cancelled.3mf' });
      await expect(page.getByTestId('import-progress')).toBeVisible();
      await page.waitForTimeout(Math.max(50, Math.floor(whole * fraction * 0.8)));
      try {
        // The control is gone the moment the import finishes, which can happen
        // between the check and the click on a loaded machine.
        await page.getByTestId('cancel-import').click({ timeout: 10_000 });
      } catch {
        await expect(
          page.getByTestId('import-progress'),
          'the cancel control only disappears when the import has finished',
        ).toHaveCount(0);
      }
      await expect(page.getByTestId('import-progress')).toHaveCount(0, { timeout: 120_000 });
      const after = await readState(page);
      const status = await statusText(page);
      if (status.includes('Import of cancelled.3mf was cancelled.')) {
        expect(after.documentId).toBe(open.documentId);
      } else {
        // Cancel arrived after the commit: the import is complete and WHOLE.
        expect(after.documentTriangleCount).toBe(300_000);
      }
      await expect(page.getByTestId('session-lost')).toHaveCount(0);
    });
  }

  test('a newer import wins over an older streamed one, whatever the older one does later', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await setIngestion(page, 'streaming');
    const before = await readState(page);
    await choose(page, { name: 'older.3mf', buffer: threeMfProductionLarge(6, 200_000) });
    await expect(page.getByTestId('import-progress')).toBeVisible();
    // Chosen while the older import is still reading: the race itself. NOT
    // through Browse, which is disabled while an import runs — a click there
    // waits for the older import to FINISH and races nothing. A dropped file
    // reaches the same `handleFiles` as the hidden input, which is used here.
    await expect(page.getByTestId('browse-button')).toBeDisabled();
    await page.getByTestId('file-input').setInputFiles({
      name: 'newer.3mf',
      mimeType: 'application/octet-stream',
      buffer: productionFamily(),
    });
    await expect
      .poll(
        async () => {
          const state = await readState(page);
          return state.loaded && state.documentId !== before.documentId ? state.partCount : -1;
        },
        { timeout: 180_000 },
      )
      .toBe(FAMILY_PARTS);
    const newer = await readState(page);
    const newerDigest = await digest(page, newer);

    // Every chance for the abandoned import to finish and misbehave.
    await page.waitForTimeout(5_000);
    const after = await readState(page);
    expect(after.documentId).toBe(newer.documentId);
    expect(after.activePartId).toBe(newer.activePartId);
    expect(after.documentTriangleCount).toBe(newer.documentTriangleCount);
    expect(await digest(page, after)).toEqual(newerDigest);
    expect(await statusText(page)).not.toMatch(/Loaded older\.3mf/);
    await expect(page.getByTestId('session-lost')).toHaveCount(0);
  });
});

test.describe('6E-A2: no ingestion mode admits what the per-entry ceiling refuses', () => {
  test('A3-R05/A4-L03: an entry declared past the per-entry ceiling is refused in EVERY mode', async ({
    page,
  }) => {
    /*
     * ROUTING IS NOT A CEILING, and this is where that is proved end to end.
     * `auto` sends an over-ceiling declaration towards the streamed path — and
     * it is refused at the ZIP directory before any path is taken, exactly as
     * the forced modes refuse it. A3 did not move `maxEntryBytes`, and nothing
     * a user can do reaches a mode that would.
     */
    test.setTimeout(180_000);
    await openHarness(page);
    for (const mode of ['buffered', 'streaming', 'auto'] as const) {
      await setIngestion(page, mode);
      await choose(page, { name: `${mode}-over.3mf`, buffer: threeMfOverEntryCeiling() });
      await expect(page.getByTestId('status-list')).toContainText(
        /per-entry expansion limit is 320 MiB/i,
        { timeout: 60_000 },
      );
      await expect(page.getByTestId('model-empty')).toBeAttached();
    }
  });
});

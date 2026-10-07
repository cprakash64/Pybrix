import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import { LengthUnit } from '@cadfixer/shared';
import type { DocumentId, SplitCommitResult } from '@cadfixer/geometry-runtime';
import { WorkspaceStore } from './workspace-store';
import { WorkflowId } from './workflows';
import { UnitBasis, effectiveUnit } from './unit-interpretation';
import type { LoadedModel } from './model';

/**
 * PYBRIX-08A: the unit interpretation at the store, where every workspace reads
 * it. The cross-workspace requirement is that Repair -> Split -> Texture ->
 * Convert -> Split all agree, that a geometry edit and its Undo cannot discard
 * it, and that the next document never inherits it.
 */
function modelNamed(fileName: string, unit: string | undefined): Omit<LoadedModel, 'revision'> {
  return {
    handle: { documentId: `doc-${fileName}` as DocumentId, revision: 1 },
    parts: [
      {
        partId: 'part-1',
        name: 'Part',
        transform: IDENTITY_PART_TRANSFORM,
        triangleCount: 1,
        vertexCount: 3,
        bounds: undefined,
        meshResourceIndex: 0,
        groupCount: 0,
        groupMaterialRefCount: 0,
        hasNormals: false,
        hasUvs: false,
      },
    ],
    render: { parts: [] },
    bounds: undefined,
    triangleCount: 1,
    vertexCount: 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 144,
    source: {
      fileName,
      fileBytes: 134,
      formatId: unit === undefined ? 'stl' : '3mf',
      encoding: unit === undefined ? 'binary' : '3mf',
      unit,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
  };
}

function loaded(fileName: string, unit?: string): WorkspaceStore {
  const store = new WorkspaceStore();
  store.commitImport(store.beginImport(fileName), modelNamed(fileName, unit));
  return store;
}
const read = (store: WorkspaceStore): ReturnType<typeof effectiveUnit> =>
  effectiveUnit(store.getSnapshot().model, store.getSnapshot().unitInterpretation);

describe('choosing how to read a unitless model', () => {
  it('starts unspecified — a unitless STL states nothing and nothing is assumed', () => {
    expect(read(loaded('a.stl')).basis).toBe(UnitBasis.Unspecified);
  });

  it('records the choice for the loaded document and nothing else', () => {
    const store = loaded('a.stl');
    expect(store.setUnitInterpretation(LengthUnit.Millimeter)).toBe(true);
    expect(read(store)).toEqual({ unit: LengthUnit.Millimeter, basis: UnitBasis.Chosen });
  });

  it('supports inches as well as millimetres', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    expect(read(store).unit).toBe(LengthUnit.Inch);
  });

  it('can be cleared again', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    store.setUnitInterpretation(undefined);
    expect(read(store).basis).toBe(UnitBasis.Unspecified);
  });

  it('is refused when the file states its own unit, which stays authoritative', () => {
    const store = loaded('a.3mf', LengthUnit.Millimeter);
    expect(store.setUnitInterpretation(LengthUnit.Inch)).toBe(false);
    expect(read(store)).toEqual({ unit: LengthUnit.Millimeter, basis: UnitBasis.File });
  });

  it('is refused with no model open', () => {
    expect(new WorkspaceStore().setUnitInterpretation(LengthUnit.Inch)).toBe(false);
  });

  it('changes no geometry and consumes no revision', () => {
    const store = loaded('a.stl');
    const before = store.getSnapshot().model;
    store.setUnitInterpretation(LengthUnit.Inch);
    const after = store.getSnapshot().model;
    expect(after?.revision).toBe(before?.revision);
    expect(after?.handle).toEqual(before?.handle);
    expect(after?.source.unit).toBeUndefined();
  });
});

describe('the reading survives workspace changes and geometry edits', () => {
  it('is the same in Repair, Split, Texture and Convert, and back in Split', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    for (const workflow of [
      WorkflowId.Repair,
      WorkflowId.Split,
      WorkflowId.Texture,
      WorkflowId.Convert,
      WorkflowId.Split,
    ]) {
      store.selectWorkflow(workflow);
      expect(read(store)).toEqual({ unit: LengthUnit.Inch, basis: UnitBasis.Chosen });
    }
  });

  it('survives a split being applied, which makes a new revision of the same document', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Centimeter);
    const model = store.getSnapshot().model;
    if (model === undefined) throw new Error('expected a model');
    const applied = store.applySplitResult({
      handle: { documentId: model.handle.documentId, revision: model.handle.revision + 1 },
      parentRevision: model.handle.revision,
      parts: model.parts,
      render: model.render,
      bounds: undefined,
      triangleCount: 1,
      vertexCount: 3,
      residentBytes: 1,
      pieceAId: 'part-1',
      resources: { triangles: 1 },
    } as unknown as SplitCommitResult);
    expect(applied).toBe(true);
    expect(read(store)).toEqual({ unit: LengthUnit.Centimeter, basis: UnitBasis.Chosen });
  });

  it('is not inherited by the next document', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    store.commitImport(store.beginImport('b.stl'), modelNamed('b.stl', undefined));
    expect(read(store).basis).toBe(UnitBasis.Unspecified);
    expect(store.getSnapshot().unitInterpretation).toBeUndefined();
  });

  it('gives a next document that states a unit that unit, not the previous choice', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    store.commitImport(store.beginImport('b.3mf'), modelNamed('b.3mf', LengthUnit.Millimeter));
    expect(read(store)).toEqual({ unit: LengthUnit.Millimeter, basis: UnitBasis.File });
  });
});

describe('Convert shares the same statement', () => {
  it('opens already holding the reading the user chose elsewhere', () => {
    const store = loaded('a.stl');
    store.setUnitInterpretation(LengthUnit.Inch);
    store.openConversion('3mf');
    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Inch);
  });

  it('opens unchosen when nothing was chosen — no default, ever', () => {
    const store = loaded('a.stl');
    store.openConversion('3mf');
    expect(store.getSnapshot().conversion.unitAssertion).toBeUndefined();
  });

  it('choosing in Convert is the shared reading Split and Texture then see', () => {
    const store = loaded('a.stl');
    store.openConversion('3mf');
    store.setConversionUnit(LengthUnit.Millimeter);
    expect(read(store)).toEqual({ unit: LengthUnit.Millimeter, basis: UnitBasis.Chosen });
  });

  it('choosing here updates an open Convert session', () => {
    const store = loaded('a.stl');
    store.openConversion('3mf');
    store.setUnitInterpretation(LengthUnit.Centimeter);
    expect(store.getSnapshot().conversion.unitAssertion).toBe(LengthUnit.Centimeter);
  });

  it('leaves a stated-unit document’s Convert session alone', () => {
    const store = loaded('a.3mf', LengthUnit.Millimeter);
    store.openConversion('3mf');
    store.setConversionUnit(LengthUnit.Inch);
    expect(store.getSnapshot().unitInterpretation).toBeUndefined();
    expect(read(store).unit).toBe(LengthUnit.Millimeter);
  });
});

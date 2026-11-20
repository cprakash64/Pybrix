import type { LengthUnit } from '@cadfixer/shared';
import { findPart, type GeometryDocument, type PartId, type PartTransform } from './document';
import { meshByteLength, type CanonicalMesh } from './mesh';
import { MAX_SUPPORTED_SPLIT_TRIANGLES } from './split-limits';

/**
 * THE EDITABLE CONNECTOR MODEL (Stage EC-1): what a document holds so that a connector can be edited later.
 *
 * WHY THIS EXISTS. A committed split is two plain parts. The pins and sockets are Boolean results baked into the two meshes, and
 * nothing records that a connector was ever there: the plan manifest dies with the candidate, and the only surviving record is the
 * page's own presentation state. Editing a connector therefore means REBUILDING it from something retained, and what is retained
 * needs an owner, an identity, a lifetime and a budget. This file is that, and only that: types, the rule for when a joint is
 * still usable, the rule for retiring one, and the retained-byte accounting. It builds no geometry, runs no Boolean and walks no
 * mesh. The engine that rebuilds from a joint is a later stage, and the transaction that applies the result is the one after.
 *
 * A JOINT is one cut interface between exactly two parts plus the connectors across it. A joint with no connector is legitimate:
 * it is what lets "add connectors to a plain cut" exist.
 *
 * VALIDITY IS DERIVED, NEVER STORED. A joint is ATTACHED exactly when both parts still hold the exact mesh objects it built, the
 * placements it was built under, and the unit it was sized in. Every mesh replacement in the product spreads the previous document
 * (`withPartMesh`, `withPartTransform`, the split candidate), so a stored `valid: true` would be carried onto a part whose mesh had
 * just changed. Identity cannot be carried wrongly. It also makes Undo free: the history restores the previous document OBJECT,
 * and a joint attached before the change is attached again afterwards with no special case.
 *
 * RETIREMENT FREES MEMORY AT ONE PLACE. A joint that is no longer attached is replaced by a bounded descriptor, with its meshes
 * released, when the resident store installs the document (`ResidentDocumentStore.replace`, the only install path). A retired
 * joint is never edited, rebuilt, re-attached or guessed.
 *
 * THIS MODULE IS GEOMETRY-FREE AND PLATFORM-FREE. It imports nothing from `geometry-runtime`, React, Three.js or any format
 * package, which is why the engine's own interface-authority type is carried here as an opaque `detail` it alone interprets.
 */

declare const jointIdBrand: unique symbol;

/** Minted by the worker (`${documentId}/joint/${n}`). Never a position in a list, never described by a caller. */
export type JointId = string & { readonly [jointIdBrand]: true };

export function jointId(value: string): JointId {
  return value as JointId;
}

/** One piece of the cut. */
export interface JointSide {
  readonly partId: PartId;
  /** The cut piece WITHOUT connectors: what a rebuild starts from. Immutable, retained by reference. */
  readonly baseMesh: CanonicalMesh;
  /**
   * The piece WITH the connectors the joint currently describes: the exact mesh OBJECT the part held when the joint was made.
   * Attachment compares by identity, so this is never a copy.
   */
  readonly builtMesh: CanonicalMesh;
  /** The placement the connectors were sized under (C03-C). Compared element by element. */
  readonly builtTransform: PartTransform;
}

/**
 * How a millimetre became a local length when the joint was built. The unit is the model's and the scale is the placement's;
 * nothing here converts or rescales anything. `mmPerCoordinate` is stored as the builder computed it and is not re-derived here.
 */
export interface JointFrame {
  readonly unit: LengthUnit;
  readonly mmPerUnit: number;
  readonly placementScale: number;
  readonly mmPerCoordinate: number;
}

/**
 * What the engine kept of the generated interface so it can validate a rebuild (its region and per-face provenance). The engine
 * owns the type of `detail`; this package only needs to know what it costs and what it is named.
 */
export interface JointInterfaceAuthority {
  /** Identifies the per-face PROVENANCE the engine kept, not the geometry: two cuts of identically-faced meshes share one. */
  readonly provenanceSHA: string;
  /** Bytes `detail` holds beyond the two base meshes. Counted into the retained total. */
  readonly retainedBytes: number;
  readonly detail: object;
}

/**
 * A pin's centre, always EXPLICIT (Stage EC-2): `local` is the exact point the pin was cut at, in the pieces' own coordinates, and
 * `u`/`v` are that point in the interface's own frame, derived from it by the engine's one function and never the other way
 * round. `local` is what a rebuild uses, so rebuilding an unchanged joint reproduces it to the bit; `u`/`v` are what an editor
 * moves and what containment is judged in. A site is validated, never trusted: the engine recomputes `u`/`v` from `local` and a
 * pair that disagrees is refused.
 */
export interface JointSite {
  readonly u: number;
  readonly v: number;
  readonly local: readonly [number, number, number];
}

/** One pin. Intent is stored in MILLIMETRES, as C03-C records it; a local length is always derived through `JointFrame`. */
export interface JointPin {
  /** Stable across edits of other pins, never reused within a joint. */
  readonly pinId: string;
  readonly site: JointSite;
  readonly diameterMm: number;
  readonly depthMm: number;
  /** Radial. The axial clearance is zero by construction (audit N6). */
  readonly clearanceMm: number;
}

export interface JointConnectorSpec {
  readonly policy: 'units-v2';
  readonly kind: 'pin';
  readonly maleSide: 'A' | 'B';
  readonly elements: readonly JointPin[];
}

export interface ConnectorJoint {
  readonly kind: 'joint';
  readonly jointId: JointId;
  readonly a: JointSide;
  readonly b: JointSide;
  readonly frame: JointFrame;
  readonly authority: JointInterfaceAuthority;
  /** `undefined` is a plain joint. */
  readonly connector: JointConnectorSpec | undefined;
}

export const JointRetirement = {
  /** A part holds a mesh other than the one the joint built. */
  GeometryChanged: 'GEOMETRY_CHANGED',
  /** A part the joint names is not in the document. */
  PartRemoved: 'PART_REMOVED',
  /** A part is placed differently from how the connectors were sized. */
  PlacementChanged: 'PLACEMENT_CHANGED',
  /** The document's unit is not the one the connectors were sized in. */
  UnitChanged: 'UNIT_CHANGED',
} as const;
export type JointRetirement = (typeof JointRetirement)[keyof typeof JointRetirement];

/** What remains of a joint after it stops being usable. Carries no geometry. */
export interface RetiredJoint {
  readonly kind: 'retired-joint';
  readonly jointId: JointId;
  readonly a: PartId;
  readonly b: PartId;
  readonly reason: JointRetirement;
  readonly retiredAtRevision: number;
  readonly pinCount: number;
}

export type JointRecord = ConnectorJoint | RetiredJoint;

/* -------------------------------------------------------------------- limits -- */

/** The most pins one joint carries: the manual request's own `count` ceiling. */
export const MAX_PINS_PER_JOINT = 4;

/** Retired descriptors a document keeps; the oldest is dropped first. */
export const MAX_RETIRED_JOINT_DESCRIPTORS = 256;

/**
 * Bytes one triangle of retained base geometry can cost: nine Float32 corner coordinates, three Uint32 indices, and the four bytes
 * of per-face provenance the interface authority keeps. This is the UNSHARED (soup) cost, so an indexed base is cheaper and never
 * dearer.
 */
export const JOINT_RETAINED_BYTES_PER_TRIANGLE = 3 * 3 * 4 + 3 * 4 + 4;

/**
 * THE RETENTION CEILING, DERIVED FROM THE SPLIT CEILING AND NOT A NUMBER OF ITS OWN. A joint exists only because a part was split,
 * and a part above `MAX_SUPPORTED_SPLIT_TRIANGLES` cannot be, so the bases a split leaves are bounded by that source's triangles.
 * This is a POLICY ceiling, not an allocation guard: above it the producer keeps the connectors as plain geometry and says so, and
 * never refuses the split on account of editability. It is arithmetic over typed-array byte lengths; a whole-browser footprint is
 * NOT claimed by it.
 */
export const MAX_JOINT_RETAINED_BYTES =
  MAX_SUPPORTED_SPLIT_TRIANGLES * JOINT_RETAINED_BYTES_PER_TRIANGLE;

/* ---------------------------------------------------------------- inspection -- */

/** Every record that still holds geometry. */
export function liveJoints(document: GeometryDocument): readonly ConnectorJoint[] {
  const live: ConnectorJoint[] = [];
  for (const record of document.joints ?? []) if (record.kind === 'joint') live.push(record);
  return live;
}

export function retiredJoints(document: GeometryDocument): readonly RetiredJoint[] {
  const retired: RetiredJoint[] = [];
  for (const record of document.joints ?? [])
    if (record.kind === 'retired-joint') retired.push(record);
  return retired;
}

/** Element-wise `===`, as the active-part STL export compares an identity placement. Both sides are finite by the document gate. */
function samePlacement(a: PartTransform, b: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export type JointAttachment =
  { readonly attached: true } | { readonly attached: false; readonly reason: JointRetirement };

/**
 * Whether a joint is still usable in this document. Pure, and the ONLY place the answer is computed.
 *
 * The order of the checks is part of the contract, so one document always gives one reason: a missing part, then a changed unit,
 * then a changed placement, then changed geometry.
 */
export function jointAttachment(
  document: GeometryDocument,
  joint: ConnectorJoint,
): JointAttachment {
  const a = findPart(document, joint.a.partId);
  const b = findPart(document, joint.b.partId);
  if (a === undefined || b === undefined)
    return { attached: false, reason: JointRetirement.PartRemoved };
  if (document.unit !== joint.frame.unit)
    return { attached: false, reason: JointRetirement.UnitChanged };
  if (
    !samePlacement(a.transform, joint.a.builtTransform) ||
    !samePlacement(b.transform, joint.b.builtTransform)
  )
    return { attached: false, reason: JointRetirement.PlacementChanged };
  if (a.mesh !== joint.a.builtMesh || b.mesh !== joint.b.builtMesh)
    return { attached: false, reason: JointRetirement.GeometryChanged };
  return { attached: true };
}

/** The live joints that are attached, in the document's own order. */
export function attachedJoints(document: GeometryDocument): readonly ConnectorJoint[] {
  return liveJoints(document).filter((joint) => jointAttachment(document, joint).attached);
}

/**
 * Bytes a document retains FOR joints, beyond the geometry its parts hold.
 *
 * Counted once per DISTINCT mesh object, and never a mesh a part already holds: an attached joint's built meshes ARE its parts'
 * meshes and cost nothing here, which is also why a base that happens to be shared with a sibling is charged once. The interface
 * authority's own bytes are added per joint.
 */
export function jointRetainedBytes(document: GeometryDocument): number {
  const live = liveJoints(document);
  if (live.length === 0) return 0;
  const counted = new Set<CanonicalMesh>();
  for (const part of document.parts) counted.add(part.mesh);
  let bytes = 0;
  for (const joint of live) {
    for (const side of [joint.a, joint.b]) {
      for (const mesh of [side.baseMesh, side.builtMesh]) {
        if (counted.has(mesh)) continue;
        counted.add(mesh);
        bytes += meshByteLength(mesh);
      }
    }
    bytes += joint.authority.retainedBytes;
  }
  return bytes;
}

/* ---------------------------------------------------------------- retirement -- */

/**
 * The document with every joint that is no longer attached replaced by its descriptor.
 *
 * Returns the SAME object, by reference, when there is nothing to retire, and shares the part array in every case: retirement
 * touches the joint list and nothing else. `revision` is the revision the successor will be installed as.
 */
export function retireDetachedJoints(
  document: GeometryDocument,
  revision: number,
): GeometryDocument {
  const records = document.joints;
  if (records === undefined || records.length === 0) return document;
  let changed = false;
  const next: JointRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'joint') {
      next.push(record);
      continue;
    }
    const attachment = jointAttachment(document, record);
    if (attachment.attached) {
      next.push(record);
      continue;
    }
    changed = true;
    next.push(
      Object.freeze({
        kind: 'retired-joint',
        jointId: record.jointId,
        a: record.a.partId,
        b: record.b.partId,
        reason: attachment.reason,
        retiredAtRevision: revision,
        pinCount: record.connector?.elements.length ?? 0,
      } satisfies RetiredJoint),
    );
  }
  if (!changed) return document;
  // The trail is bounded and the oldest descriptor goes first. Live joints are never dropped here.
  let retired = next.filter((record) => record.kind === 'retired-joint').length;
  const kept: JointRecord[] = [];
  for (const record of next) {
    if (record.kind === 'retired-joint' && retired > MAX_RETIRED_JOINT_DESCRIPTORS) {
      retired -= 1;
      continue;
    }
    kept.push(record);
  }
  return { ...document, joints: kept };
}

import {
  formatBytes,
  formatCount,
  geometryValidationFailed,
  isLengthUnit,
  type ErrorDetails,
} from '@cadfixer/shared';
import { meshByteLength } from './mesh';
import {
  DEFAULT_DOCUMENT_LIMITS,
  documentTriangleCount,
  documentVertexCount,
  distinctMeshes,
  type DocumentLimits,
  type GeometryDocument,
} from './document';
import { MeshValidationSeverity, validateMeshStructure } from './validation';
import {
  attachedJoints,
  jointRetainedBytes,
  liveJoints,
  MAX_JOINT_RETAINED_BYTES,
  MAX_PINS_PER_JOINT,
  MAX_RETIRED_JOINT_DESCRIPTORS,
  retiredJoints,
  type ConnectorJoint,
  type JointSide,
  JointRetirement,
} from './joint';
import type { CanonicalMesh } from './mesh';

/**
 * STRUCTURAL validation of a geometry document, run before it becomes
 * authoritative.
 *
 * WHAT THIS IS FOR. `validateMeshStructure` answers "is this mesh well
 * formed?". It cannot answer "do two parts claim the same id?", "is this
 * transform finite?", or "does this document fit in the memory a session is
 * allowed to hold?" — questions that only exist once geometry has structure
 * around it. A candidate document that fails any of them must not partially
 * replace the current one; it must not replace it at all.
 *
 * WHAT THIS IS NOT. Not mesh health. A part whose triangles are degenerate is a
 * VALID document describing a defective model, and refusing it would leave the
 * product unable to load the very files it exists to repair. The line is the
 * same one the 3MF research drew: structural validity is not printability.
 */

export const DocumentValidationCode = {
  NoParts: 'DOCUMENT_NO_PARTS',
  DuplicatePartId: 'DOCUMENT_DUPLICATE_PART_ID',
  EmptyPartId: 'DOCUMENT_EMPTY_PART_ID',
  InvalidTransform: 'DOCUMENT_INVALID_TRANSFORM',
  InvalidUnit: 'DOCUMENT_INVALID_UNIT',
  InvalidPartMesh: 'DOCUMENT_INVALID_PART_MESH',
  NameTooLong: 'DOCUMENT_NAME_TOO_LONG',
  MaterialRefTooLong: 'DOCUMENT_MATERIAL_REF_TOO_LONG',
  TooManyParts: 'DOCUMENT_TOO_MANY_PARTS',
  TooManyTriangles: 'DOCUMENT_TOO_MANY_TRIANGLES',
  TooManyVertices: 'DOCUMENT_TOO_MANY_VERTICES',
  TooManyBytes: 'DOCUMENT_TOO_MANY_BYTES',
  // ---- the editable connector model (Stage EC-1) ----
  JointDuplicateId: 'DOCUMENT_JOINT_DUPLICATE_ID',
  /** A joint that contradicts itself: an empty id, one part on both sides, an unusable frame, side or authority. */
  JointMalformed: 'DOCUMENT_JOINT_MALFORMED',
  /** A connector spec outside the model: no pins, too many, a repeated pin id, a size that is not positive and finite. */
  JointConnectorMalformed: 'DOCUMENT_JOINT_CONNECTOR_MALFORMED',
  /** One part inside two ATTACHED joints, so an edit of one would rebuild geometry the other still describes. */
  JointPartShared: 'DOCUMENT_JOINT_PART_SHARED',
  JointRetentionTooLarge: 'DOCUMENT_JOINT_RETENTION_TOO_LARGE',
  TooManyJoints: 'DOCUMENT_TOO_MANY_JOINTS',
  /** A retired descriptor that names no reason this model has, or carries an impossible revision or count. */
  RetiredJointMalformed: 'DOCUMENT_RETIRED_JOINT_MALFORMED',
} as const;

export type DocumentValidationCode =
  (typeof DocumentValidationCode)[keyof typeof DocumentValidationCode];

export interface DocumentValidationIssue {
  readonly code: DocumentValidationCode;
  readonly message: string;
  /** Counts, indices and identifiers only — never coordinates. */
  readonly details?: ErrorDetails;
}

export interface DocumentValidationReport {
  readonly valid: boolean;
  readonly issues: readonly DocumentValidationIssue[];
  readonly partCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  /**
   * Bytes of DISTINCT geometry.
   *
   * Counted once per mesh object, not once per part, because that is what the
   * document actually holds: a thousand placements of one component cost one
   * mesh. Counting per part would refuse documents that fit comfortably.
   */
  readonly geometryBytes: number;
}

export interface DocumentValidationOptions {
  readonly limits?: DocumentLimits;
  /**
   * Whether to run full structural validation on each part's mesh.
   *
   * Defaults to true. Disabled only where the caller has already validated
   * every mesh in this document and would otherwise walk every coordinate a
   * second time — the repair commit path, where the candidate mesh went through
   * `assertMeshStructure` moments earlier and the other parts are the SAME
   * OBJECTS that were validated when they were committed.
   */
  readonly validateMeshes?: boolean;
}

/**
 * A transform is 12 finite numbers. Nothing else is a placement.
 *
 * Takes `readonly number[]` rather than `PartTransform` ON PURPOSE. A document
 * reaching validation may have been built from a wire payload whose shape was
 * asserted rather than proved, and a check whose parameter type already
 * guarantees the answer is not a check.
 */
export function isValidPartTransform(transform: readonly number[]): boolean {
  if (transform.length !== 12) return false;
  for (const value of transform) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

export function validateGeometryDocument(
  document: GeometryDocument,
  options: DocumentValidationOptions = {},
): DocumentValidationReport {
  const limits = options.limits ?? DEFAULT_DOCUMENT_LIMITS;
  const validateMeshes = options.validateMeshes ?? true;
  const issues: DocumentValidationIssue[] = [];

  const partCount = document.parts.length;

  if (partCount === 0) {
    issues.push({
      code: DocumentValidationCode.NoParts,
      message: 'This document contains no parts.',
    });
  }

  if (partCount > limits.maxParts) {
    issues.push({
      code: DocumentValidationCode.TooManyParts,
      message: `This document declares ${formatCount(partCount)} parts; Pybrix's limit is ${formatCount(limits.maxParts)} parts.`,
      details: { partCount, limit: limits.maxParts },
    });
  }

  if (document.unit !== undefined && !isLengthUnit(document.unit)) {
    issues.push({
      code: DocumentValidationCode.InvalidUnit,
      message: 'This document states a unit Pybrix does not recognise.',
      details: { unit: String(document.unit) },
    });
  }

  const seen = new Set<string>();
  for (let index = 0; index < document.parts.length; index += 1) {
    const part = document.parts[index];
    if (part === undefined) continue;

    if (part.id.length === 0) {
      issues.push({
        code: DocumentValidationCode.EmptyPartId,
        message: 'A part in this document has no identifier.',
        details: { partIndex: index },
      });
    } else if (seen.has(part.id)) {
      issues.push({
        code: DocumentValidationCode.DuplicatePartId,
        message: 'Two parts in this document claim the same identifier.',
        details: { partIndex: index, partId: part.id },
      });
    } else {
      seen.add(part.id);
    }

    if (!isValidPartTransform(part.transform)) {
      issues.push({
        code: DocumentValidationCode.InvalidTransform,
        message: 'A part in this document has an unusable placement transform.',
        details: { partIndex: index, partId: part.id, values: part.transform.length },
      });
    }

    if (part.name !== undefined && part.name.length > limits.maxNameLength) {
      issues.push({
        code: DocumentValidationCode.NameTooLong,
        message: 'A part name in this document is longer than Pybrix will keep.',
        details: { partIndex: index, length: part.name.length, limit: limits.maxNameLength },
      });
    }

    if (part.materialRef !== undefined && part.materialRef.length > limits.maxMaterialRefLength) {
      issues.push({
        code: DocumentValidationCode.MaterialRefTooLong,
        message: 'A material reference in this document is longer than Pybrix will keep.',
        details: {
          partIndex: index,
          length: part.materialRef.length,
          limit: limits.maxMaterialRefLength,
        },
      });
    }
  }

  if (validateMeshes) {
    // Per DISTINCT mesh: validating a shared mesh once per placement would make
    // a 1,000-placement document 1,000 times more expensive to admit than the
    // one it actually is.
    let meshIndex = 0;
    for (const mesh of distinctMeshes(document)) {
      const report = validateMeshStructure(mesh);
      if (!report.valid) {
        issues.push({
          code: DocumentValidationCode.InvalidPartMesh,
          message: 'A part in this document does not contain a well-formed mesh.',
          details: {
            meshIndex,
            codes: report.issues
              .filter((issue) => issue.severity === MeshValidationSeverity.Error)
              .map((issue) => issue.code)
              .join(','),
          },
        });
      }
      meshIndex += 1;
    }
  }

  validateDocumentJoints(document, limits, validateMeshes, issues);

  const triangles = documentTriangleCount(document);
  const vertices = documentVertexCount(document);
  let geometryBytes = 0;
  for (const mesh of distinctMeshes(document)) geometryBytes += meshByteLength(mesh);

  if (triangles > limits.maxTotalTriangles) {
    issues.push({
      code: DocumentValidationCode.TooManyTriangles,
      message: `This document contains ${formatCount(triangles)} triangles; Pybrix's limit is ${formatCount(limits.maxTotalTriangles)} triangles.`,
      details: { triangleCount: triangles, limit: limits.maxTotalTriangles },
    });
  }
  if (vertices > limits.maxTotalVertices) {
    issues.push({
      code: DocumentValidationCode.TooManyVertices,
      message: `This document contains ${formatCount(vertices)} vertices; Pybrix's limit is ${formatCount(limits.maxTotalVertices)} vertices.`,
      details: { vertexCount: vertices, limit: limits.maxTotalVertices },
    });
  }
  if (geometryBytes > limits.maxTotalGeometryBytes) {
    issues.push({
      code: DocumentValidationCode.TooManyBytes,
      message: `This document holds ${formatBytes(geometryBytes)} of geometry; Pybrix's limit is ${formatBytes(limits.maxTotalGeometryBytes)} in one session.`,
      details: { geometryBytes, limit: limits.maxTotalGeometryBytes },
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    partCount,
    triangleCount: triangles,
    vertexCount: vertices,
    geometryBytes,
  };
}

/**
 * The GATE. Throws unless the document may become authoritative.
 *
 * Mirrors `assertMeshStructure`: producing a document is not success, passing
 * this is.
 */
export function assertGeometryDocument(
  document: GeometryDocument,
  operation: string,
  options: DocumentValidationOptions = {},
): void {
  const report = validateGeometryDocument(document, options);
  if (report.valid) return;

  const codes = [...new Set(report.issues.map((issue) => issue.code))];
  throw geometryValidationFailed(`${operation} produced a document Pybrix cannot accept.`, {
    operation,
    partCount: report.partCount,
    triangleCount: report.triangleCount,
    issueCount: report.issues.length,
    codes: codes.join(','),
  });
}

/* ------------------------------------------------------------------- joints -- */

const RETIREMENT_REASONS: ReadonlySet<string> = new Set(Object.values(JointRetirement));

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function sideProblem(side: JointSide): string | undefined {
  if (side.partId.length === 0) return 'a side names no part';
  if (!isValidPartTransform(side.builtTransform)) return 'a side has an unusable placement';
  return undefined;
}

function jointProblem(joint: ConnectorJoint): string | undefined {
  if (joint.jointId.length === 0) return 'a joint has no identifier';
  if (joint.a.partId === joint.b.partId) return 'a joint names one part on both sides';
  const side = sideProblem(joint.a) ?? sideProblem(joint.b);
  if (side !== undefined) return side;
  const { frame } = joint;
  if (!isLengthUnit(frame.unit)) return 'a joint states a unit Pybrix does not recognise';
  if (
    !positiveFinite(frame.mmPerUnit) ||
    !positiveFinite(frame.placementScale) ||
    !positiveFinite(frame.mmPerCoordinate)
  )
    return 'a joint has an unusable physical frame';
  if (!Number.isSafeInteger(joint.nextPinOrdinal) || joint.nextPinOrdinal < 1)
    return 'a joint has no next pin ordinal';
  const { authority } = joint;
  if (authority.provenanceSHA.length === 0) return 'a joint has no interface identity';
  if (!Number.isSafeInteger(authority.retainedBytes) || authority.retainedBytes < 0)
    return 'a joint states an impossible retained size';
  return undefined;
}

function connectorProblem(joint: ConnectorJoint): string | undefined {
  const spec = joint.connector;
  if (spec === undefined) return undefined;
  // Read as a string: the type says `A | B`, but a document can be built from a wire payload whose shape was asserted, not proved.
  const maleSide: string = spec.maleSide;
  if (maleSide !== 'A' && maleSide !== 'B') return 'a connector names no male side';
  const count = spec.elements.length;
  if (count < 1 || count > MAX_PINS_PER_JOINT)
    return 'a connector has a number of pins outside the model';
  const ids = new Set<string>();
  for (const pin of spec.elements) {
    if (pin.pinId.length === 0 || ids.has(pin.pinId))
      return 'a connector repeats or omits a pin identifier';
    ids.add(pin.pinId);
    if (!positiveFinite(pin.diameterMm) || !positiveFinite(pin.depthMm))
      return 'a pin size is not positive and finite';
    if (!Number.isFinite(pin.clearanceMm) || pin.clearanceMm < 0)
      return 'a pin clearance is not finite and non-negative';
    // The length is read as a number: the type says three, but a document can be built from a wire payload whose shape was asserted.
    const localLength: number = pin.site.local.length;
    if (
      !Number.isFinite(pin.site.u) ||
      !Number.isFinite(pin.site.v) ||
      localLength !== 3 ||
      !pin.site.local.every((value) => Number.isFinite(value))
    )
      return 'a pin site is not finite';
  }
  return undefined;
}

function validateDocumentJoints(
  document: GeometryDocument,
  limits: DocumentLimits,
  validateMeshes: boolean,
  issues: DocumentValidationIssue[],
): void {
  const records = document.joints;
  if (records === undefined || records.length === 0) return;
  const live = liveJoints(document);
  const retired = retiredJoints(document);

  if (
    live.length > Math.floor(limits.maxParts / 2) ||
    retired.length > MAX_RETIRED_JOINT_DESCRIPTORS
  )
    issues.push({
      code: DocumentValidationCode.TooManyJoints,
      message: 'This document records more connector joints than Pybrix will keep.',
      details: { liveJoints: live.length, retiredJoints: retired.length },
    });

  const ids = new Set<string>();
  for (const record of records) {
    if (record.jointId.length > 0 && ids.has(record.jointId))
      issues.push({
        code: DocumentValidationCode.JointDuplicateId,
        message: 'Two connector joints in this document claim the same identifier.',
        details: { jointId: record.jointId },
      });
    ids.add(record.jointId);
  }

  for (const joint of live) {
    const problem = jointProblem(joint);
    if (problem !== undefined)
      issues.push({
        code: DocumentValidationCode.JointMalformed,
        message: 'A connector joint in this document contradicts itself.',
        details: { jointId: joint.jointId, problem },
      });
    const connector = connectorProblem(joint);
    if (connector !== undefined)
      issues.push({
        code: DocumentValidationCode.JointConnectorMalformed,
        message: 'A connector in this document is outside what Pybrix can describe.',
        details: { jointId: joint.jointId, problem: connector },
      });
  }

  for (const record of retired) {
    if (
      record.jointId.length === 0 ||
      !RETIREMENT_REASONS.has(record.reason) ||
      !Number.isSafeInteger(record.retiredAtRevision) ||
      record.retiredAtRevision < 1 ||
      !Number.isSafeInteger(record.pinCount) ||
      record.pinCount < 0 ||
      record.pinCount > MAX_PINS_PER_JOINT
    )
      issues.push({
        code: DocumentValidationCode.RetiredJointMalformed,
        message: 'A retired connector record in this document is not one Pybrix can describe.',
        details: { jointId: record.jointId },
      });
  }

  // One part, one attached joint: an edit rebuilds BOTH of a joint's pieces, so a second joint over either would describe geometry
  // the first has just replaced. Retired and detached records do not count: they can no longer be edited.
  const owner = new Map<string, string>();
  for (const joint of attachedJoints(document))
    for (const id of [joint.a.partId, joint.b.partId]) {
      const other = owner.get(id);
      if (other !== undefined && other !== joint.jointId)
        issues.push({
          code: DocumentValidationCode.JointPartShared,
          message: 'Two connector joints in this document claim the same part.',
          details: { partId: id, jointId: joint.jointId },
        });
      owner.set(id, joint.jointId);
    }

  const retained = jointRetainedBytes(document);
  if (retained > MAX_JOINT_RETAINED_BYTES)
    issues.push({
      code: DocumentValidationCode.JointRetentionTooLarge,
      message: `This document retains ${formatBytes(retained)} for editable connectors; Pybrix's limit is ${formatBytes(MAX_JOINT_RETAINED_BYTES)}.`,
      details: { retainedBytes: retained, limit: MAX_JOINT_RETAINED_BYTES },
    });

  if (validateMeshes) {
    // The retained bases are geometry too, and they are checked the way a part's is: per DISTINCT mesh, and never one a part holds.
    const checked = new Set<CanonicalMesh>(distinctMeshes(document));
    for (const joint of live)
      for (const side of [joint.a, joint.b])
        for (const mesh of [side.baseMesh, side.builtMesh]) {
          if (checked.has(mesh)) continue;
          checked.add(mesh);
          if (!validateMeshStructure(mesh).valid)
            issues.push({
              code: DocumentValidationCode.InvalidPartMesh,
              message:
                'A retained connector piece in this document does not contain a well-formed mesh.',
              details: { jointId: joint.jointId, partId: side.partId },
            });
        }
  }
}

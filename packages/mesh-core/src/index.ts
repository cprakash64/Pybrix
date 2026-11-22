export {
  createIndexArray,
  createPositionArray,
  meshByteLength,
  meshTransferables,
  triangleCount,
  vertexCount,
} from './mesh';
export type {
  CanonicalMesh,
  IndexArray,
  MeshGroup,
  MeshMetadata,
  NormalArray,
  PositionArray,
  SourceFormatId,
  UvArray,
} from './mesh';

export {
  applyPartTransform,
  placeMesh,
  composePartTransforms,
  DEFAULT_DOCUMENT_LIMITS,
  distinctMeshes,
  documentTriangleCount,
  documentVertexCount,
  findPart,
  IDENTITY_PART_TRANSFORM,
  partId,
  partIndexOf,
  singlePartDocument,
  transformBounds,
  unionBounds,
  withPartMesh,
  withPartTransform,
} from './document';
export type {
  DocumentLimits,
  GeometryDocument,
  GeometryPart,
  PartId,
  PartTransform,
  SinglePartDocumentOptions,
} from './document';

export {
  attachedJoints,
  jointAttachment,
  jointId,
  JOINT_RETAINED_BYTES_PER_TRIANGLE,
  jointRetainedBytes,
  JointRetirement,
  liveJoints,
  MAX_JOINT_RETAINED_BYTES,
  MAX_PINS_PER_JOINT,
  MAX_RETIRED_JOINT_DESCRIPTORS,
  retireDetachedJoints,
  retiredByInstall,
  retiredJoints,
} from './joint';
export type {
  ConnectorJoint,
  JointAttachment,
  JointConnectorSpec,
  JointFrame,
  JointId,
  JointInterfaceAuthority,
  JointPin,
  JointRecord,
  JointSide,
  JointSite,
  RetiredJoint,
} from './joint';

export {
  assertGeometryDocument,
  DocumentValidationCode,
  isValidPartTransform,
  validateGeometryDocument,
} from './document-validation';
export type {
  DocumentValidationIssue,
  DocumentValidationOptions,
  DocumentValidationReport,
} from './document-validation';

export {
  buildDrawableTriangles,
  computeBounds,
  computeVertexNormals,
  triangleNormal,
} from './analysis';

export {
  drawableTriangleBytes,
  MAX_IMPORT_GEOMETRY_BYTES,
  MAX_UNSHARED_IMPORT_TRIANGLES,
  measureImportGeometry,
  RENDER_BYTES_PER_TRIANGLE,
  UNSHARED_IMPORT_BYTES_PER_TRIANGLE,
} from './import-cost';
export type { ImportGeometryCost } from './import-cost';
export { isWithinSplitTriangleCeiling, MAX_SUPPORTED_SPLIT_TRIANGLES } from './split-limits';
export {
  classifyPlacement,
  IDENTITY_PLACEMENT,
  PLACEMENT_CLASSIFICATION_TOLERANCE,
  placementLinearDeterminant,
  PlacementRefusal,
  placementReversesOrientation,
} from './placement';
export type { PlacementClass } from './placement';
export type { DrawableTriangles } from './analysis';
export type { MeshBounds, Vector3Tuple } from './analysis';

export {
  assertMeshStructure,
  MeshValidationCode,
  MeshValidationSeverity,
  validateMeshStructure,
} from './validation';
export type {
  MeshValidationIssue,
  MeshValidationOptions,
  MeshValidationReport,
} from './validation';

export { exactVertexKey } from './exact-vertex-key';
export { EditRefusal, MAX_EDIT_REGION_TRIANGLES, MAX_EDIT_SOURCE_TRIANGLES } from './edit-limits';

export {
  classifyEditPlane,
  createEditFrame,
  growEditRegion,
  measureEditPlanarity,
  selectEditSurface,
  transformEditNormal,
  transformEditPoint,
  triangleEditNormal,
} from './edit-geometry';
export type {
  EditFrame,
  EditPlane,
  EditVector,
  RegionGrowthOptions,
  RegionPlanarity,
  SurfaceRegion,
} from './edit-geometry';

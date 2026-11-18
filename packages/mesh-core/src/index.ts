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
  PlacementRefusal,
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

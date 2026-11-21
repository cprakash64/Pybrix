import {
  createIndexArray,
  triangleCount,
  validateMeshStructure,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  BoundaryLoopRefusal,
  buildTopologicalGeometry,
  extractBoundaryLoops,
  findBoundaryLoop,
  recoverVertexIdentity,
  type BoundaryLoop,
  type VertexIdentityResult,
} from '@cadfixer/mesh-topology';
import { assertNever } from '@cadfixer/shared';
import {
  FaceBvh,
  createCounters,
  faceBoxOf,
  type BroadphaseBudget,
} from '@cadfixer/mesh-core/spatial';
import { earClip, EarClipRefusal, projectionAxisFor, type PatchTriangle } from './ear-clip';
import { assessPlanarity, type LoopPoint } from './planarity';
import { narrowHoleFillLimits, patchFaceCountFor, type HoleFillLimits } from './limits';
import { HoleFillStatus } from './status';
import {
  analysePatchConnectivity,
  analysePatchFaces,
  analysePatchOrientation,
  collectNonManifoldDefects,
  diffNonManifoldDefects,
  eulerCharacteristicOf,
  validateSourcePreservation,
} from './validate';
import type {
  HoleFillOutcome,
  HoleFillPhaseTimings,
  HoleFillRequest,
  HoleFillValidationSummary,
  PatchNarrowphase,
} from './contract';

/**
 * THE HOLE-FILL PIPELINE.
 *
 * ONE ORDERED SEQUENCE, and the order is the contract:
 *
 *   resolve part → part size → resolve loop → eligibility → boundary size →
 *   planarity → deterministic projection → ear clipping → candidate assembly →
 *   structural validation → source immutability → topology postconditions →
 *   orientation → connectivity → Euler → patch-attributed intersection
 *
 * TRIANGULATION SUCCESS IS NEVER ENGINE SUCCESS. Every stage after the
 * triangulator is a chance to reject what it produced, and the last of them —
 * patch-attributed intersection — is the one ADR 0018 exists to insist upon: a
 * patch can satisfy every topological postcondition and the Euler check and
 * still pass straight through an internal wall.
 *
 * IT NEVER TOUCHES AUTHORITATIVE GEOMETRY. It takes a source mesh, returns a
 * candidate, and mutates nothing. Refusal, failure and cancellation all leave
 * the caller's mesh exactly as it was, which the byte-level preservation check
 * asserts rather than assumes.
 *
 * CANCELLATION IS TERMINATION, not a polled flag. This runs as one synchronous
 * pass inside a disposable worker: a message-based cancel could not be read
 * until it returned, so a polled token would be a lie. The controller kills the
 * worker, and the resource ceilings below bound how long a pathological input
 * can run before it would have finished anyway.
 */

export interface HoleFillEngineInput {
  /** The part's canonical mesh. Never modified. */
  readonly source: CanonicalMesh;
  readonly request: HoleFillRequest;
  /** The exact predicate. Injected; see `PatchNarrowphase`. */
  readonly narrowphase: PatchNarrowphase;
  /** May only NARROW the production ceilings. */
  readonly limits?: Partial<HoleFillLimits>;
  /** Injected so timings are measurable without a platform global. */
  readonly now?: () => number;
}

export interface HoleFillEngineResult {
  readonly outcome: HoleFillOutcome;
  /** Present ONLY when the status is `VALID_CANDIDATE`. */
  readonly candidate: CanonicalMesh | undefined;
}

/** Pairs buffered before a flush to the narrowphase. 8,192 pairs = 64 KiB. */
const PAIR_BATCH = 8_192;

export function runHoleFill(input: HoleFillEngineInput): HoleFillEngineResult {
  const now = input.now ?? ((): number => 0);
  const limits = narrowHoleFillLimits(input.limits);
  const started = now();
  const timings: MutableTimings = {
    loopResolution: 0,
    eligibility: 0,
    planarity: 0,
    triangulation: 0,
    candidateAssembly: 0,
    structuralValidation: 0,
    topologyValidation: 0,
    broadphase: 0,
    narrowphase: 0,
  };

  const source = input.source;
  const sourceFaceCount = triangleCount(source);

  const fail = (
    status: HoleFillStatus,
    partial: Partial<MutableSummary> = {},
  ): HoleFillEngineResult => ({
    outcome: {
      status,
      identity: input.request,
      summary: summaryOf({ sourceFaceCount, ...partial }, timings, Math.max(0, now() - started)),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    },
    candidate: undefined,
  });

  /*
   * PART SIZE FIRST, before anything allocates. The validator is what makes a
   * large part expensive, and refusing after building its connectivity would be
   * paying the cost the ceiling exists to avoid.
   */
  if (sourceFaceCount > limits.maxPartFaces) {
    return fail(HoleFillStatus.RefusedPartSize);
  }

  /* ------------------------------------------------------ resolve loop -- */

  const loopStart = now();
  const identity = recoverVertexIdentity(source);
  const loopSet = extractBoundaryLoops(source, { maxLoopVertices: limits.maxBoundaryVertices });
  timings.loopResolution = now() - loopStart;

  const loop = findBoundaryLoop(loopSet, input.request.boundaryLoopId);
  if (loop === undefined) {
    return fail(HoleFillStatus.UnknownLoop, { boundaryLoopsBefore: loopSet.loops.length });
  }

  const eligibilityStart = now();
  if (loop.refusal !== undefined) {
    timings.eligibility = now() - eligibilityStart;
    return fail(statusForLoopRefusal(loop.refusal), {
      boundaryVertexCount: loop.vertexCount,
      boundaryLoopsBefore: loopSet.loops.length,
    });
  }

  const boundaryVertexCount = loop.vertices.length;
  timings.eligibility = now() - eligibilityStart;

  // Belt and braces: extraction already refuses above the ceiling, and this
  // states the same rule where a reader looks for it. Both must agree, and a
  // test pins that they do.
  if (boundaryVertexCount > limits.maxBoundaryVertices) {
    return fail(HoleFillStatus.RefusedBoundarySize, {
      boundaryVertexCount,
      boundaryLoopsBefore: loopSet.loops.length,
    });
  }

  /* -------------------------------------------------------- planarity -- */

  const planarityStart = now();
  const points = loopPoints(source, identity, loop);
  const planarity = assessPlanarity(points);
  timings.planarity = now() - planarityStart;

  const base: Partial<MutableSummary> = {
    sourceFaceCount,
    boundaryVertexCount,
    boundaryLoopsBefore: loopSet.loops.length,
    planarityRatio: planarity.relative,
  };

  if (planarity.degenerate) {
    return fail(HoleFillStatus.RefusedDegenerateBoundary, base);
  }
  if (!planarity.planar) {
    return fail(HoleFillStatus.RefusedNonPlanar, base);
  }

  const normal = planarity.normal ?? ([0, 0, 1] as const);
  const projectionAxis = projectionAxisFor(normal);

  /* ------------------------------------------------------ triangulate -- */

  const triangulationStart = now();
  const clipped = earClip(points, normal);
  timings.triangulation = now() - triangulationStart;

  const withAxis = { ...base, projectionAxis };

  if (clipped.refusal !== undefined) {
    switch (clipped.refusal) {
      case EarClipRefusal.NoEarFound:
        return fail(HoleFillStatus.NoEarFound, withAxis);
      case EarClipRefusal.TooFewVertices:
      case EarClipRefusal.DegenerateProjection:
        return fail(HoleFillStatus.RefusedDegenerateBoundary, withAxis);
      default:
        return assertNever(clipped.refusal, 'ear-clip refusal');
    }
  }

  const expectedPatchFaces = patchFaceCountFor(boundaryVertexCount);
  if (clipped.triangles.length !== expectedPatchFaces || clipped.addedVertices !== 0) {
    /*
     * NOT A REFUSAL. `n - 2` triangles and zero added vertices are structural
     * properties of this algorithm, so a violation means the triangulator is
     * broken rather than that the geometry is unsupported.
     */
    return fail(HoleFillStatus.ValidationFailed, {
      ...withAxis,
      patchFaceCount: clipped.triangles.length,
      addedVertexCount: clipped.addedVertices,
    });
  }

  /* ------------------------------------------------ assemble candidate -- */

  const assemblyStart = now();
  const candidate = assembleCandidate(source, identity, loop, clipped.triangles);
  timings.candidateAssembly = now() - assemblyStart;

  const patchFaceCount = clipped.triangles.length;
  const candidateFaceCount = sourceFaceCount + patchFaceCount;

  /* ------------------------------------------ structural + immutability -- */

  const structuralStart = now();
  const structural = validateMeshStructure(candidate);
  const preservation = validateSourcePreservation(source, candidate);
  timings.structuralValidation = now() - structuralStart;

  const shape: Partial<MutableSummary> = {
    ...withAxis,
    patchFaceCount,
    addedVertexCount: 0,
  };

  if (!structural.valid) return fail(HoleFillStatus.ValidationFailed, shape);
  if (
    !preservation.positionsIdentical ||
    !preservation.indexPrefixIdentical ||
    !preservation.faceOrderPreserved
  ) {
    return fail(HoleFillStatus.ValidationFailed, shape);
  }

  /* ------------------------------------------------ topology + winding -- */

  const topologyStart = now();
  /*
   * THE CANDIDATE'S WELDED IDENTITY IS THE SOURCE'S, and that is a consequence
   * of append-only rather than an assumption: the position buffer is
   * byte-identical, and `recoverVertexIdentity` assigns ids by first appearance
   * over the positions, so the same buffer yields the same numbering. It is
   * recomputed rather than reused so the claim is CHECKED by the very next
   * assertion instead of trusted.
   */
  const candidateIdentity = recoverVertexIdentity(candidate);
  const afterLoops = extractBoundaryLoops(candidate, {
    maxLoopVertices: limits.maxBoundaryVertices,
  });

  const patchFaces = analysePatchFaces(
    candidate,
    candidateIdentity.cornerToVertex,
    sourceFaceCount,
  );
  const orientation = analysePatchOrientation(
    candidate,
    candidateIdentity.cornerToVertex,
    sourceFaceCount,
    loop.vertices,
  );
  const connectivity = analysePatchConnectivity(
    candidate,
    candidateIdentity.cornerToVertex,
    sourceFaceCount,
    loop.vertices,
  );

  /*
   * THE NON-MANIFOLD DIFFERENTIAL, BY DEFECT IDENTITY.
   *
   * Not by kind, and not by count. A source that already contains one
   * non-manifold edge and a candidate that contains that edge PLUS a new one
   * have identical defect KINDS, so a kind comparison reports no regression
   * while the patch has manufactured a defect. The sets are compared instead,
   * and the number below is how many defects the candidate has that the source
   * did not.
   */
  const sourceDefects = collectNonManifoldDefects(source, identity);
  const candidateDefects = collectNonManifoldDefects(candidate, candidateIdentity);
  const defectDifference = diffNonManifoldDefects(sourceDefects, candidateDefects);

  const eulerBefore = eulerCharacteristicOf(source, identity.cornerToVertex);
  const eulerAfter = eulerCharacteristicOf(candidate, candidateIdentity.cornerToVertex);
  timings.topologyValidation = now() - topologyStart;

  const selectedLoopRemoved = findBoundaryLoop(afterLoops, loop.id) === undefined;

  const topology: Partial<MutableSummary> = {
    ...shape,
    boundaryLoopsAfter: afterLoops.loops.length,
    selectedLoopRemoved,
    newNonManifoldDefectCount: defectDifference.total,
    degeneratePatchFaces: patchFaces.degenerateFaces,
    duplicatePatchFaces: patchFaces.duplicateFaces,
    foreignPatchCorners: connectivity.foreignCorners,
    opposingBoundaryEdges: orientation.opposing,
    agreeingBoundaryEdges: orientation.agreeing,
    eulerApplicable: true,
    eulerBefore,
    eulerAfter,
    eulerPassed: eulerAfter === eulerBefore + 1,
  };

  if (patchFaces.nonFiniteCoordinates) return fail(HoleFillStatus.ValidationFailed, topology);
  if (patchFaces.degenerateFaces > 0 || patchFaces.duplicateFaces > 0) {
    return fail(HoleFillStatus.DegeneratePatch, topology);
  }
  if (!selectedLoopRemoved) return fail(HoleFillStatus.ValidationFailed, topology);
  if (afterLoops.loops.length !== loopSet.loops.length - 1) {
    return fail(HoleFillStatus.ValidationFailed, topology);
  }
  if (defectDifference.total > 0) {
    return fail(HoleFillStatus.NonManifoldCreated, topology);
  }
  if (orientation.agreeing > 0 || orientation.inconsistentInteriorEdges > 0) {
    return fail(HoleFillStatus.ValidationFailed, topology);
  }
  if (orientation.opposing !== boundaryVertexCount) {
    return fail(HoleFillStatus.ValidationFailed, topology);
  }
  if (connectivity.foreignCorners > 0 || !connectivity.diskLike) {
    return fail(HoleFillStatus.ValidationFailed, topology);
  }
  if (eulerAfter !== eulerBefore + 1) {
    return fail(HoleFillStatus.ValidationFailed, topology);
  }

  /* ---------------------------------------- patch-attributed intersection -- */

  const intersection = checkPatchIntersections({
    candidate,
    sourceFaceCount,
    candidateFaceCount,
    narrowphase: input.narrowphase,
    limits,
    now,
    timings,
  });

  const complete: Partial<MutableSummary> = {
    ...topology,
    invalidPatchSourcePairs: intersection.invalidPatchSourcePairs,
    invalidPatchPatchPairs: intersection.invalidPatchPatchPairs,
    broadphaseCandidates: intersection.counters.candidates,
    broadphaseAabbTests: intersection.counters.aabbTests,
    broadphaseNodeVisits: intersection.counters.nodeVisits,
    narrowphaseChecks: intersection.testedPairs,
    narrowphaseRefusals: intersection.unclassifiedPairs,
  };

  const finish = (status: HoleFillStatus): HoleFillEngineResult => ({
    outcome: {
      status,
      identity: input.request,
      summary: summaryOf(complete, timings, Math.max(0, now() - started)),
      intersectionSamples: intersection.samples,
      samplesTruncated: intersection.samplesTruncated,
    },
    candidate: status === HoleFillStatus.ValidCandidate ? candidate : undefined,
  });

  if (intersection.budgetExceeded) return finish(HoleFillStatus.ResourceLimit);
  // A pair the exact narrowphase could not examine must NEVER be absorbed into
  // a clean result.
  if (!intersection.complete) return finish(HoleFillStatus.ValidationFailed);
  if (intersection.invalidPatchSourcePairs > 0 || intersection.invalidPatchPatchPairs > 0) {
    return finish(HoleFillStatus.SelfIntersectionCreated);
  }

  return finish(HoleFillStatus.ValidCandidate);
}

/* ------------------------------------------------------------ internals -- */

function statusForLoopRefusal(refusal: BoundaryLoopRefusal): HoleFillStatus {
  switch (refusal) {
    case BoundaryLoopRefusal.NonManifoldAdjacency:
      return HoleFillStatus.RefusedNonManifoldBoundary;
    case BoundaryLoopRefusal.AmbiguousOrientation:
      return HoleFillStatus.RefusedAmbiguousOrientation;
    case BoundaryLoopRefusal.DegenerateSegment:
    case BoundaryLoopRefusal.TooFewVertices:
    case BoundaryLoopRefusal.NonFinite:
      return HoleFillStatus.RefusedDegenerateBoundary;
    case BoundaryLoopRefusal.TooManyVertices:
      return HoleFillStatus.RefusedBoundarySize;
    case BoundaryLoopRefusal.BranchedBoundary:
    case BoundaryLoopRefusal.ConvergentBoundary:
    case BoundaryLoopRefusal.NotClosed:
    case BoundaryLoopRefusal.RepeatedVertex:
      return HoleFillStatus.RefusedNotSimpleLoop;
    default:
      return assertNever(refusal, 'boundary loop refusal');
  }
}

/** Loop vertices as Float64 points, widened exactly from the stored Float32. */
function loopPoints(
  mesh: CanonicalMesh,
  identity: VertexIdentityResult,
  loop: BoundaryLoop,
): readonly LoopPoint[] {
  const points: LoopPoint[] = [];
  for (const vertex of loop.vertices) {
    const corner = (identity.vertexRepresentativeCorner[vertex] ?? 0) * 3;
    points.push([
      mesh.positions[corner] ?? 0,
      mesh.positions[corner + 1] ?? 0,
      mesh.positions[corner + 2] ?? 0,
    ]);
  }
  return points;
}

/**
 * Builds the candidate mesh: the source, then the patch.
 *
 * POSITIONS ARE THE SOURCE'S BUFFER, SHARED BY REFERENCE, because the
 * triangulator adds no vertex and moves none. Copying it would produce
 * identical bytes at the cost of a whole second position buffer — for a
 * 250,000-face part that is 9 MB of allocation to reproduce what already
 * exists. Sharing is safe precisely because nothing here writes to it, and the
 * byte-level preservation check runs on the result either way.
 *
 * INDICES ARE APPENDED, never rewritten. The source's index bytes are copied
 * verbatim into the head of the new buffer, so face order and face identity are
 * preserved and `[0, sourceFaceCount)` keeps meaning what it meant.
 *
 * PATCH CORNERS ARE REPRESENTATIVE CORNERS OF THE LOOP'S WELDED VERTICES, so a
 * patch triangle references coordinates that already exist rather than a copy
 * of them.
 */
function assembleCandidate(
  source: CanonicalMesh,
  identity: VertexIdentityResult,
  loop: BoundaryLoop,
  triangles: readonly PatchTriangle[],
): CanonicalMesh {
  const indices = createIndexArray(source.indices.length + triangles.length * 3);
  indices.set(source.indices, 0);

  let write = source.indices.length;
  for (const triangle of triangles) {
    for (const slot of triangle) {
      const vertex = loop.vertices[slot] ?? 0;
      indices[write] = identity.vertexRepresentativeCorner[vertex] ?? 0;
      write += 1;
    }
  }

  return {
    positions: source.positions,
    indices,
    ...(source.normals === undefined ? {} : { normals: source.normals }),
    ...(source.uvs === undefined ? {} : { uvs: source.uvs }),
    ...(source.groups === undefined ? {} : { groups: source.groups }),
    metadata: source.metadata,
  };
}

/* -------------------------------------------------- intersection check -- */

interface IntersectionInput {
  readonly candidate: CanonicalMesh;
  readonly sourceFaceCount: number;
  readonly candidateFaceCount: number;
  readonly narrowphase: PatchNarrowphase;
  readonly limits: HoleFillLimits;
  readonly now: () => number;
  readonly timings: MutableTimings;
}

interface IntersectionOutcome {
  readonly complete: boolean;
  readonly budgetExceeded: boolean;
  readonly testedPairs: number;
  readonly unclassifiedPairs: number;
  readonly invalidPatchSourcePairs: number;
  readonly invalidPatchPatchPairs: number;
  readonly counters: { nodeVisits: number; aabbTests: number; candidates: number };
  readonly samples: Uint32Array;
  readonly samplesTruncated: boolean;
}

/**
 * DOES ANY MANUFACTURED FACE TAKE PART IN AN INVALID INTERSECTION?
 *
 * PATCH-ATTRIBUTED, NEVER AGGREGATE. Only (patch × source) and (patch × patch)
 * pairs are produced, so a crossing the user's file already had cannot be
 * blamed on this operation — and an unchanged total is never read as proof of
 * anything, because totals are not what is compared.
 *
 * BOUNDED BY A SPATIAL INDEX, not by a pairwise scan. The research
 * implementation tested every (patch, face) pair and exhausted a 1.7 GB heap;
 * that shape is forbidden here. Each patch triangle QUERIES a hierarchy with
 * its own box, and the candidates stream through a fixed 8,192-pair buffer that
 * is reused, so nothing proportional to `patchFaces × sourceFaces` is ever
 * materialised.
 *
 * PRE-EXISTING SOURCE DEFECTS ARE OUT OF SCOPE BY CONSTRUCTION: no
 * source/source pair is ever generated, so none can be tested and none can be
 * counted.
 */
function checkPatchIntersections(input: IntersectionInput): IntersectionOutcome {
  const { candidate, sourceFaceCount, candidateFaceCount, limits, now, timings } = input;
  const counters = createCounters();
  const budget: BroadphaseBudget = {
    maxNodeVisits: limits.maxBvhNodeVisits,
    maxAabbTests: limits.maxAabbTests,
    maxCandidates: limits.maxBroadphaseCandidates,
  };

  const empty: IntersectionOutcome = {
    complete: true,
    budgetExceeded: false,
    testedPairs: 0,
    unclassifiedPairs: 0,
    invalidPatchSourcePairs: 0,
    invalidPatchPatchPairs: 0,
    counters,
    samples: new Uint32Array(0),
    samplesTruncated: false,
  };
  if (candidateFaceCount <= sourceFaceCount) return empty;

  const broadphaseStart = now();
  const geometry = buildTopologicalGeometry(candidate);
  const sourceTree = FaceBvh.build(geometry.positions, geometry.triangles, 0, sourceFaceCount);
  const patchTree = FaceBvh.build(
    geometry.positions,
    geometry.triangles,
    sourceFaceCount,
    candidateFaceCount,
  );
  timings.broadphase += now() - broadphaseStart;

  input.narrowphase.begin({
    positions: geometry.positions,
    triangles: geometry.triangles,
    patchFaceStart: sourceFaceCount,
    maxSamples: limits.maxSamples,
  });

  const pairs = new Uint32Array(PAIR_BATCH * 2);
  let buffered = 0;
  let testedPairs = 0;
  let unclassifiedPairs = 0;
  let invalidPatchSourcePairs = 0;
  let invalidPatchPatchPairs = 0;
  /*
   * MUTATED FROM CLOSURES, so it lives in a record. A plain `let` written only
   * inside `flush` and `emit` is narrowed to `false` by control-flow analysis
   * at every read, which makes the ceiling checks look unreachable to the
   * linter — and would make them genuinely unreachable to a future reader who
   * believed the narrowing.
   */
  const scan = { complete: true, budgetExceeded: false };

  const flush = (): boolean => {
    if (buffered === 0) return true;
    const narrowStart = now();
    const result = input.narrowphase.classify(pairs, buffered);
    timings.narrowphase += now() - narrowStart;
    buffered = 0;

    testedPairs += result.testedPairs;
    unclassifiedPairs += result.unclassifiedPairs;
    invalidPatchSourcePairs += result.invalidPatchSourcePairs;
    invalidPatchPatchPairs += result.invalidPatchPatchPairs;
    if (!result.complete) scan.complete = false;
    if (testedPairs > limits.maxNarrowphasePairs) {
      scan.budgetExceeded = true;
      return false;
    }
    return true;
  };

  const emit = (a: number, b: number): boolean => {
    pairs[buffered * 2] = a;
    pairs[buffered * 2 + 1] = b;
    buffered += 1;
    if (buffered < PAIR_BATCH) return true;
    return flush();
  };

  try {
    for (
      let patch = sourceFaceCount;
      patch < candidateFaceCount && !scan.budgetExceeded;
      patch += 1
    ) {
      const box = faceBoxOf(geometry.positions, geometry.triangles, patch);

      const broadStart = now();
      const sourceOk = sourceTree.queryBox(
        box.lo,
        box.hi,
        (face) => emit(patch, face),
        counters,
        budget,
      );
      // `patch < other` keeps each patch/patch pair once and never pairs a face
      // with itself.
      const patchOk = sourceOk
        ? patchTree.queryBox(
            box.lo,
            box.hi,
            (face) => (face <= patch ? true : emit(patch, face)),
            counters,
            budget,
          )
        : false;
      timings.broadphase += now() - broadStart;

      if (!sourceOk || !patchOk) {
        // A stop is either a budget firing or a flush refusing; both mean the
        // scan is incomplete, and an incomplete scan is never a clean verdict.
        scan.budgetExceeded = true;
        break;
      }
    }

    if (!scan.budgetExceeded) flush();

    const samples = input.narrowphase.samples();
    return {
      complete: scan.complete,
      budgetExceeded: scan.budgetExceeded,
      testedPairs,
      unclassifiedPairs,
      invalidPatchSourcePairs,
      invalidPatchPatchPairs,
      counters,
      samples: samples.samples,
      samplesTruncated: samples.truncated,
    };
  } finally {
    // Released even when a batch threw, so a failed run cannot leave the
    // kernel's uploaded geometry alive behind it.
    input.narrowphase.end();
  }
}

/* -------------------------------------------------------------- summary -- */

interface MutableTimings {
  loopResolution: number;
  eligibility: number;
  planarity: number;
  triangulation: number;
  candidateAssembly: number;
  structuralValidation: number;
  topologyValidation: number;
  broadphase: number;
  narrowphase: number;
}

type MutableSummary = Omit<HoleFillValidationSummary, 'totalDurationMs' | 'phaseMilliseconds'>;

function summaryOf(
  partial: Partial<MutableSummary>,
  timings: MutableTimings,
  totalDurationMs: number,
): HoleFillValidationSummary {
  const phaseMilliseconds: HoleFillPhaseTimings = { ...timings };
  return {
    boundaryVertexCount: partial.boundaryVertexCount ?? 0,
    sourceFaceCount: partial.sourceFaceCount ?? 0,
    patchFaceCount: partial.patchFaceCount ?? 0,
    addedVertexCount: partial.addedVertexCount ?? 0,
    boundaryLoopsBefore: partial.boundaryLoopsBefore ?? 0,
    boundaryLoopsAfter: partial.boundaryLoopsAfter ?? 0,
    selectedLoopRemoved: partial.selectedLoopRemoved ?? false,
    newNonManifoldDefectCount: partial.newNonManifoldDefectCount ?? 0,
    degeneratePatchFaces: partial.degeneratePatchFaces ?? 0,
    duplicatePatchFaces: partial.duplicatePatchFaces ?? 0,
    foreignPatchCorners: partial.foreignPatchCorners ?? 0,
    opposingBoundaryEdges: partial.opposingBoundaryEdges ?? 0,
    agreeingBoundaryEdges: partial.agreeingBoundaryEdges ?? 0,
    invalidPatchSourcePairs: partial.invalidPatchSourcePairs ?? 0,
    invalidPatchPatchPairs: partial.invalidPatchPatchPairs ?? 0,
    broadphaseCandidates: partial.broadphaseCandidates ?? 0,
    broadphaseAabbTests: partial.broadphaseAabbTests ?? 0,
    broadphaseNodeVisits: partial.broadphaseNodeVisits ?? 0,
    narrowphaseChecks: partial.narrowphaseChecks ?? 0,
    narrowphaseRefusals: partial.narrowphaseRefusals ?? 0,
    planarityRatio: partial.planarityRatio ?? Number.NaN,
    projectionAxis: partial.projectionAxis ?? -1,
    eulerApplicable: partial.eulerApplicable ?? false,
    eulerBefore: partial.eulerBefore ?? 0,
    eulerAfter: partial.eulerAfter ?? 0,
    eulerPassed: partial.eulerPassed ?? false,
    totalDurationMs,
    phaseMilliseconds,
  };
}

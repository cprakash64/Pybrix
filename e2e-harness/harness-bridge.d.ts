/**
 * The harness page's bridge, as Playwright sees it.
 *
 * ONE FUNCTION, and it returns a DIGEST — never geometry. The worker compares
 * its own authoritative bytes and sends back a hash and a length, so proving
 * "these coordinates were not rewritten" does not require making the page an
 * owner of the coordinates. See `apps/web/e2e-harness/main.tsx`.
 */
export {};

interface GeometryEditCandidateHandle {
  readonly documentId: string;
  readonly sourceRevision: number;
  readonly partId: string;
  readonly operation: string;
  readonly generation: number;
  readonly candidateId: string;
}

interface HarnessPartDigest {
  readonly partId: string;
  readonly name?: string | null;
  readonly materialRef?: string | null;
  readonly meshResourceIndex: number;
  readonly transform: readonly number[];
  readonly positionBytes: number;
  readonly indexBytes: number;
  readonly positionDigest: string;
  readonly indexDigest: string;
}

/**
 * What an export attempt reports back.
 *
 * A LENGTH AND A HEAD, never the file. The bytes are the user's artifact and
 * belong in a download; a test needs to know how big it was, what format it
 * looks like, and what the writer observed about the conversion.
 */
/** One progress report, with the moment it arrived. */
interface HarnessExportPhase {
  readonly fraction: number;
  readonly note?: string;
  /** Milliseconds since the export was requested. */
  readonly at: number;
}

interface HarnessExportResult {
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly observations?: readonly string[];
  readonly triangleCount?: number;
  readonly partCount?: number;
  readonly meshResourceCount?: number;
  readonly durationMs: number;
  readonly head?: string;
  readonly progressUpdates: number;
  /**
   * The progress timeline.
   *
   * What makes a responsiveness window checkable: a test can see that the
   * period it sampled reached `validating` and then `complete`, rather than
   * ending when the bytes happened to exist.
   */
  readonly phases: readonly HarnessExportPhase[];
  readonly cancelLatencyMs?: number;
}

interface HarnessLocalRepairResult {
  readonly status: string;
  readonly message?: string;
  readonly planHash?: string;
  readonly localPlan?: Record<string, unknown>;
  readonly candidateId?: string;
  readonly candidateRevision?: number;
  readonly candidatePartId?: string;
  readonly outcome?: Record<string, unknown>;
  readonly notRun?: string;
  readonly acceptance?: string;
  readonly candidateTriangles?: number;
  readonly candidateNonManifoldVertices?: number;
  readonly sourceNonManifoldVertices?: number;
  readonly durationMs: number;
  readonly cancelLatencyMs?: number;
}

declare global {
  interface Window {
    readonly cadfixerHarness?: {
      beginTestEdit(
        documentId: string,
        revision: number,
        partId: string,
        dx: number,
      ): Promise<GeometryEditCandidateHandle>;
      previewTestEdit(candidate: GeometryEditCandidateHandle): Promise<{ vertexCount: number }>;
      commitTestEdit(
        candidate: GeometryEditCandidateHandle,
        documentId: string,
        revision: number,
        partId: string,
      ): Promise<{ revision: number; recordId: string }>;
      discardTestEdit(candidate: GeometryEditCandidateHandle): Promise<boolean>;
      undoTestEdit(documentId: string, revision: number, recordId: string): Promise<number>;
      beginTestBoolean(
        operation: 'union' | 'difference' | 'intersection',
        segments?: number,
        rings?: number,
        testCrash?: boolean,
      ): void;
      awaitTestBoolean(): Promise<{
        status: string;
        triangles?: number;
        elapsedMs: number;
        stats: { active: number; created: number; terminated: number };
        phases: readonly { phase: string; at: number }[];
      }>;
      cancelTestBoolean(): void;
      testBooleanPhases(): readonly { phase: string; at: number }[];
      /**
       * Selects a Surface Texture region through the real worker and store,
       * exactly as a viewport pick does — for tests that must name a part the
       * camera cannot isolate. Resolves to the number of selected faces.
       */
      selectTextureSurface(partId: string, triangleIndex: number): Promise<number>;
      resetSplitQualification(): void;
      splitQualificationEvents(): readonly {
        documentId: string;
        generation: number;
        booleanIndex: number;
        operation: string;
        phase: string;
        at: number;
        stats: { active: number; created: number; terminated: number };
      }[];
      /** Stage 6E-A2: which 3MF reader the harness worker's real import uses. */
      setIngestion(mode: 'buffered' | 'streaming' | 'auto', maxEntryBytes?: number): Promise<void>;
      digest(
        documentId: string,
        revision: number,
      ): Promise<{
        ok: boolean;
        distinctMeshes?: number;
        unit?: string | null;
        parts: readonly HarnessPartDigest[];
      }>;
      exportDocument(
        documentId: string,
        revision: number,
        target: 'stl' | 'obj' | '3mf',
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): Promise<HarnessExportResult>;
      /** Starts an export and returns immediately, so a probe can run beside it. */
      beginExport(
        documentId: string,
        revision: number,
        target: 'obj' | '3mf',
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): void;
      awaitExport(): Promise<HarnessExportResult>;
      cancelExport(): void;
      exportActiveOperation(): string | undefined;
      exportLiveWorkers(): number;
      exportLiveChannels(): number;

      /**
       * Boundary components of one part, as SCALARS.
       *
       * The only way a caller obtains a `boundaryLoopId` — and it carries no
       * coordinates, because a browser test needs to know an opening exists and
       * whether it is fillable, not where its vertices are.
       */
      listBoundaryLoops(
        documentId: string,
        revision: number,
        partId: string,
      ): Promise<HarnessBoundaryLoops>;
      /** Starts a fill and returns immediately, so a probe can run beside it. */
      beginHoleFill(
        documentId: string,
        revision: number,
        partId: string,
        boundaryLoopId: string,
        options?: { readonly cancelAfterMs?: number },
      ): void;
      awaitHoleFill(): Promise<HarnessHoleFillResult>;
      cancelHoleFill(): void;
      holeFillActiveOperation(): string | undefined;
      holeFillLiveWorkers(): number;
      holeFillLiveChannels(): number;
      beginLocalRepair(
        documentId: string,
        revision: number,
        partId: string,
        options?: {
          readonly cancelAfterMs?: number;
          readonly workCeiling?: number;
          readonly failVerifierAfterMs?: number;
        },
      ): void;
      awaitLocalRepair(): Promise<HarnessLocalRepairResult>;
      cancelLocalRepair(): void;
      applyLocalRepair(): Promise<Record<string, unknown>>;
      undoLocalRepair(): Promise<Record<string, unknown>>;
      discardLocalRepair(): Promise<boolean>;
      localRepairVerifiers(): { live: number; created: number };
    };
  }
}

interface HarnessBoundaryLoopSummary {
  readonly boundaryLoopId: string;
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly fillable: boolean;
  readonly refusal?: string;
}

interface HarnessBoundaryLoops {
  readonly partId: string;
  readonly loopCount: number;
  readonly loops: readonly HarnessBoundaryLoopSummary[];
  readonly truncated: boolean;
}

/**
 * What a fill attempt reports back.
 *
 * A HANDLE AND SCALARS, never a mesh. The candidate stays resident in the
 * authoritative worker; the page learns its identity and what the validators
 * measured.
 */
interface HarnessHoleFillResult {
  readonly status: string;
  readonly message?: string;
  readonly candidateId?: string;
  readonly candidatePartId?: string;
  readonly candidateRevision?: number;
  readonly candidateLoopId?: string;
  readonly summary?: Record<string, number | boolean | Record<string, number>>;
  /** The authoritative worker's byte-preservation verdict. Stage 4B-1B1-R1. */
  readonly sourcePositionsPreserved?: boolean;
  readonly sourceFacePrefixPreserved?: boolean;
  readonly durationMs: number;
  readonly cancelLatencyMs?: number;
  readonly startedFaceCount?: number;
}

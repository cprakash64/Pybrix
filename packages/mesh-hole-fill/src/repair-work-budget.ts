/**
 * THE DETERMINISTIC REPAIR-WORK BUDGET — REPAIR-CORE-06A.
 *
 * WHY NOT A TIMEOUT. A wall-clock limit would make the SAME model repair on one machine and
 * refuse on another, and would cut a repair off at an arbitrary instant. A raw face count or a raw
 * pinched-vertex count would not either: the work a model costs depends on how many candidates the
 * search has to build and test, and measurement (REPAIR-CORE-05D/05E) showed two models of
 * identical triangle count differing by a factor of three in that work.
 *
 * WHAT IS COUNTED. Integer units of the operations that dominated the measured cost:
 *
 *   - one candidate construction (a dry run or the install half of an exact attempt),
 *   - one exact-gate test (the enumeration plus the Geogram classification of one candidate),
 *   - one face visited by the winding traversal, in blocks of `WINDING_FACES_PER_UNIT`.
 *
 * The weights are RATIOS OF MEASURED COST, not tuning knobs (see `docs/design/REPAIR_CORE_06A.md`
 * for the derivation). Same geometry + same product version = same count on every machine.
 *
 * HOW A LIMIT IS ENFORCED. `charge` only ever INCREMENTS and never throws, so it is safe to call
 * from inside a tentative reconstruction. `check` throws `WorkLimitReached`, and the search calls
 * it ONLY at safe points: between two `tryReconstruct` calls, where the mesh is either exactly as
 * it was or holds a complete, validated operation. A limit therefore never leaves a half
 * operation behind.
 */

export const RepairWorkPhase = {
  Primary: 'primary',
  Residual: 'residual',
} as const;
export type RepairWorkPhase = (typeof RepairWorkPhase)[keyof typeof RepairWorkPhase];

/**
 * The two deterministic work ceilings of a local repair. Declared HERE, in the leaf the planner may
 * import, so the production constants do not have to reach the orchestrator (and through it the
 * search, the gate and the BVH) from the authoritative worker.
 */
export interface LocalRepairLimits {
  /** Work units for the primary search; undefined = unmetered (measurement runs only). */
  readonly primary: number | undefined;
  /** Work units for the residual phase; undefined = unmetered (measurement runs only). */
  readonly residual: number | undefined;
}

export const REPAIR_WORK_UNITS = Object.freeze({
  /** One candidate construction (dry run, or the install half of an exact attempt). */
  candidate: 1,
  /** The fixed cost of one exact-gate test, before the pairs it tests are counted. */
  exactTest: 8,
  /**
   * Narrowphase pairs per unit. The exact test's cost is dominated by the pairs it classifies, not
   * by how many tests there are: X11's tests cost the same ~13 ms as X12's while testing 4,000
   * pairs against 6,000, so a flat per-test charge let X11 run ~30x longer per unit than X12.
   * One unit is one candidate construction (~15-40 us); one pair is ~3 us.
   */
  pairsPerUnit: 10,
});

/** Faces the winding traversal visits per unit of work. */
export const WINDING_FACES_PER_UNIT = 64;

export interface RepairWorkCounters {
  readonly candidates: number;
  readonly exactTests: number;
  readonly windingFaces: number;
  readonly retryAttempts: number;
  /** Narrowphase pairs the exact gate classified for this phase. */
  readonly testedPairs: number;
}

export interface RepairWorkMeter {
  readonly phase: RepairWorkPhase;
  /** The ceiling in units, or undefined for a measuring run that must never stop. */
  readonly limit: number | undefined;
  readonly used: () => number;
  readonly counters: () => RepairWorkCounters;
  readonly exhausted: () => boolean;
  /** Adds work. Never throws. */
  readonly chargeCandidate: () => void;
  readonly chargeExactTest: () => void;
  /** Adds the narrowphase pairs one exact test classified. Never throws. */
  readonly chargePairs: (pairs: number) => void;
  readonly chargeWindingFaces: (faces: number) => void;
  /** Notes a retry attempt for reporting; it costs nothing beyond the work it triggers. */
  readonly noteRetry: () => void;
  /** Throws `WorkLimitReached` when the ceiling has been reached. Call only at safe points. */
  readonly check: () => void;
}

/** Thrown at a safe point once a meter's ceiling is reached. Not an error: a typed stop. */
export class WorkLimitReached extends Error {
  public readonly phase: RepairWorkPhase;
  public constructor(phase: RepairWorkPhase) {
    super(`repair work limit reached (${phase})`);
    this.name = 'WorkLimitReached';
    this.phase = phase;
  }
}

export function createWorkMeter(
  phase: RepairWorkPhase,
  limit: number | undefined,
): RepairWorkMeter {
  let candidates = 0;
  let exactTests = 0;
  let windingFaces = 0;
  let retryAttempts = 0;
  let testedPairs = 0;
  const used = (): number =>
    candidates * REPAIR_WORK_UNITS.candidate +
    exactTests * REPAIR_WORK_UNITS.exactTest +
    Math.ceil(testedPairs / REPAIR_WORK_UNITS.pairsPerUnit) +
    Math.ceil(windingFaces / WINDING_FACES_PER_UNIT);
  const exhausted = (): boolean => limit !== undefined && used() >= limit;
  return {
    phase,
    limit,
    used,
    counters: () => ({ candidates, exactTests, windingFaces, retryAttempts, testedPairs }),
    exhausted,
    chargeCandidate: (): void => {
      candidates += 1;
    },
    chargeExactTest: (): void => {
      exactTests += 1;
    },
    chargePairs: (pairs: number): void => {
      testedPairs += Math.max(0, Math.floor(pairs));
    },
    chargeWindingFaces: (faces: number): void => {
      windingFaces += Math.max(0, Math.floor(faces));
    },
    noteRetry: (): void => {
      retryAttempts += 1;
    },
    check: (): void => {
      if (exhausted()) throw new WorkLimitReached(phase);
    },
  };
}

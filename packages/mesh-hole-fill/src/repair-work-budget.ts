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

export const REPAIR_WORK_UNITS = Object.freeze({
  /** One candidate construction (dry run, or the install half of an exact attempt). */
  candidate: 1,
  /** One exact-gate test: about eight candidate constructions at the measured rates. */
  exactTest: 8,
});

/** Faces the winding traversal visits per unit of work. */
export const WINDING_FACES_PER_UNIT = 64;

export interface RepairWorkCounters {
  readonly candidates: number;
  readonly exactTests: number;
  readonly windingFaces: number;
  readonly retryAttempts: number;
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
  const used = (): number =>
    candidates * REPAIR_WORK_UNITS.candidate +
    exactTests * REPAIR_WORK_UNITS.exactTest +
    Math.ceil(windingFaces / WINDING_FACES_PER_UNIT);
  const exhausted = (): boolean => limit !== undefined && used() >= limit;
  return {
    phase,
    limit,
    used,
    counters: () => ({ candidates, exactTests, windingFaces, retryAttempts }),
    exhausted,
    chargeCandidate: (): void => {
      candidates += 1;
    },
    chargeExactTest: (): void => {
      exactTests += 1;
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

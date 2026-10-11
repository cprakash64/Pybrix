/**
 * A SAFE BOUNDARY INSIDE LONG LOCAL WORK.
 *
 * Auto Split's local passes (six renders, component labelling, plane scoring) are synchronous loops
 * over every face of a part that may have two million of them. A cancellation that is only read
 * between whole passes is read seconds late. A `Checkpoint` is called every `CHECKPOINT_STRIDE`
 * units of work, at a point where nothing is half-written and abandoning the pass leaves nothing
 * behind: it returns when the work may continue and THROWS when it must stop (the worker passes
 * `context.throwIfCancelled`, which reads the shared cancellation word and can therefore see a cancel
 * from inside synchronous work).
 *
 * It never changes a result: with or without one, a pass computes exactly the same numbers in the
 * same order.
 */
export type Checkpoint = () => void;

/**
 * Units of work (faces, corners, candidates' elements) between two checkpoints: a few milliseconds
 * each. A POWER OF TWO ON PURPOSE: a loop tests `(n & CHECKPOINT_MASK) === 0`, one instruction, where
 * `n % CHECKPOINT_STRIDE === 0` is an integer division per iteration. The division version of this
 * very checkpoint made `normalizeGeometry` 3x slower and a 512-pixel render 1.5x slower at two
 * million triangles (measured), which is a poor price for a polled flag.
 */
export const CHECKPOINT_STRIDE = 32_768;
export const CHECKPOINT_MASK = CHECKPOINT_STRIDE - 1;

export const NO_CHECKPOINT: Checkpoint = (): void => undefined;

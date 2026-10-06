import type { LocalRepairLimits } from './repair-work-budget';

/**
 * THE PRODUCTION WORK CEILINGS, in the deterministic units of `repair-work-budget.ts`.
 *
 * DERIVED FROM MEASUREMENT, NOT CHOSEN (docs/design/REPAIR_CORE_06A.md). The 19 qualification
 * models (D0 and the 18 Thingi10K models X1-X19 minus X11), run unmetered, cost at most:
 *
 *   primary   940,072 units  (X12, 471,462 faces, 28 s)   then X7 287,461, D0 52,202
 *   residual   18,350 units  (X15)                        then X8 5,429, X17 2,388
 *
 * PRIMARY = 1,200,000, about 1.28x the largest completed model, so the largest known success has
 * ~28% headroom and nothing measured is cut off. RESIDUAL = 40,000, about 2.2x the largest
 * completed residual phase. X11 (732,584 faces, 9,240 pinched vertices, a closed-fan model whose
 * every exact test costs ~13 ms) reaches the primary limit after ~27 s having repaired ~35 sites;
 * unmetered it would need hours. That is the MVP complexity limit: a typed `partial_limit`.
 *
 * The limits are numbers of WORK, never seconds, faces or bytes: the same geometry reaches the same
 * verdict on every machine. Changing a unit weight or a limit needs the qualification re-run.
 */
export const PRODUCTION_REPAIR_WORK_LIMITS: LocalRepairLimits = Object.freeze({
  primary: 1_200_000,
  residual: 40_000,
});

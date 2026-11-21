/**
 * CONNECTOR SUPPORT POLICY (Release 2, Slice 2D) — the ONE named authority for how much material must surround a connector.
 *
 * `support-v1` states a GEOMETRIC CONSISTENCY INVARIANT and nothing more:
 *
 *     material support below the generated mating interface is no weaker, geometrically, than the margin Pybrix already
 *     requires around the connector AT that interface.
 *
 * The margin is the one the manual placement rule (`connectorCenters`) has applied to the cut face since the first split
 * commit: the larger of eight split tolerances and 0.35 of the pin radius. This module moves that number to a single place so
 * the cut-face rule and the support validators cannot disagree about it; it does not choose it.
 *
 * WHAT THIS POLICY DOES NOT CLAIM. It does not say 0.35 is enough to print safely, that a connector is mechanically strong,
 * or that it can be manufactured. Pybrix has no material, process, layer-orientation, infill, wall-count or load model, and
 * the ratio has no recorded derivation: it is adopted as the existing contract. It is dimensionless (a multiple of the pin
 * radius, with a numerical floor in split tolerances that scales with the model), so it reads no unit, no placement scale and
 * no clearance. A physical minimum in millimetres needs the unit and transform semantics of audit C03 and is a separate rule.
 *
 * LEAF MODULE: it imports nothing, so no geometry, mesh, kernel or UI code can reach it through here and a boundary test can
 * hold that.
 */

/** The version of the support rule. Appears in refusals; it is not a plan or manifest field (those keep `legacy-v0`). */
export const SUPPORT_POLICY_ID = 'support-v1' as const;

export const CONNECTOR_SUPPORT_POLICY = Object.freeze({
  id: SUPPORT_POLICY_ID,
  /** The margin, as a multiple of the PIN radius (not the socket radius: clearance does not enter it). */
  edgeMarginPinRadiusRatio: 0.35,
  /** The numerical floor, in split tolerances. It scales with the model, like the tolerance itself. */
  edgeMarginToleranceMultiple: 8,
});

/**
 * How much material must surround a connector: `max(8 · tolerance, 0.35 · pinRadius)`.
 *
 * `pinRadius` is the male pin's radius (`diameter / 2`), taken from the request and never recomputed from the socket;
 * `tolerance` is the split tolerance the kernel returned for this cut.
 */
export function connectorSupportMargin(pinRadius: number, tolerance: number): number {
  return Math.max(
    CONNECTOR_SUPPORT_POLICY.edgeMarginToleranceMultiple * tolerance,
    CONNECTOR_SUPPORT_POLICY.edgeMarginPinRadiusRatio * pinRadius,
  );
}

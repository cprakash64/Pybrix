import { createContext, useContext, type ReactNode } from 'react';

/**
 * AN INTERNAL SEAM FOR NARROWING THE AUTOMATIC-REPAIR WORK LIMIT — REPAIR-CORE-07.
 *
 * The product always repairs under its own production budget. This context exists so the
 * end-to-end HARNESS — which is never shipped — can ask for a SMALLER limit and so exercise the
 * typed "too complex for this pass" outcome with a small model instead of a thirty-second one.
 *
 * WHY A CONTEXT AND NOT A URL OPTION. Version 06B read a work-limit URL option in production code,
 * which let any link make automatic repair stop early — a confusing, support-sensitive behaviour
 * with no product requirement behind it. A context has no public surface: the shipped entry point
 * never provides a value, so the default (`undefined`: the product's own budget) is the only one
 * a user can ever reach. The worker independently takes the SMALLER of any requested ceiling and
 * its own budget, so nothing can raise the limit either.
 */
const RepairWorkCeilingContext = createContext<number | undefined>(undefined);

export function RepairWorkCeilingProvider({
  ceiling,
  children,
}: {
  readonly ceiling: number | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return <RepairWorkCeilingContext value={ceiling}>{children}</RepairWorkCeilingContext>;
}

/** The narrowed limit the harness provided, or `undefined` in the product. */
export function useRepairWorkCeiling(): number | undefined {
  return useContext(RepairWorkCeilingContext);
}

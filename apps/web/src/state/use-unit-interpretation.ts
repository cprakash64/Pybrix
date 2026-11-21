import { useCallback } from 'react';
import type { LengthUnit } from '@cadfixer/shared';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { canInterpretUnit, effectiveUnit, type UnitBasis } from './unit-interpretation';

/** What the unit now in force is, where it came from, and whether the user can set it. */
export interface UnitInterpretationControls {
  readonly unit: LengthUnit | undefined;
  readonly basis: UnitBasis;
  /** True only for a document whose file states no unit. */
  readonly canChoose: boolean;
  readonly choose: (unit: LengthUnit | undefined) => void;
}

/**
 * The shared unit reading for the loaded document (PYBRIX-08A). Every workspace
 * that needs a physical size — Split connectors, Surface Texture, Convert —
 * reads THIS, so the answer cannot differ between them.
 *
 * A HOOK BOUNDARY, deliberately: callers receive primitives, which also keeps
 * the React Compiler from treating the store's `model` as something this
 * derivation might alias.
 */
export function useUnitInterpretation(): UnitInterpretationControls {
  const { model, unitInterpretation } = useWorkspaceState();
  const store = useWorkspaceStore();
  const { unit, basis } = effectiveUnit(model, unitInterpretation);
  const canChoose = canInterpretUnit(model);
  const choose = useCallback(
    (next: LengthUnit | undefined): void => {
      store.setUnitInterpretation(next);
    },
    [store],
  );
  return { unit, basis, canChoose, choose };
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { RepairOperation } from '@cadfixer/geometry-runtime';
import { useConservativeRepair, type ConservativeRepairControls } from './use-conservative-repair';
import { useHoleFillWorkflow, type HoleFillControls } from './use-hole-fill-workflow';
import { useAutoSplit, type AutoSplitControls, type AutoSplitOptions } from './use-auto-split';
import { useSplitWorkflow, type SplitControls } from './use-split-workflow';
import { useTextureWorkflow, type TextureControls } from './use-texture-workflow';
import { useJointSync } from './use-joint-sync';
import { useConnectorEdit, type ConnectorEditControls } from './use-connector-edit';
import { useTopologyAnalysis, type TopologyAnalysisControls } from './use-topology-analysis';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { RepairPlanState } from './workspace-store';

/**
 * ONE INSTANCE OF EACH WORKFLOW CONTROLLER, for the whole application.
 *
 * The analysis, repair and hole-fill hooks each start automatic work and hold
 * the only handle to their running operation. They used to be called inside
 * the panels that showed them, which had two costs: the analysis hook ran in
 * two panels at once, each with its own once-per-revision guard, so both could
 * start an analysis for the same import; and nothing
 * outside those panels — the inspector's "Fix this", the viewport HUD — could
 * reach the operation a panel owned. Each hook now runs exactly once, here,
 * and every surface reads the same controls.
 *
 * Three providers rather than one, so a component test can mount exactly the
 * controller its component uses and nothing else.
 */

const AnalysisContext = createContext<TopologyAnalysisControls | undefined>(undefined);
const RepairContext = createContext<RepairControls | undefined>(undefined);
const HoleFillContext = createContext<HoleFillControls | undefined>(undefined);
const SplitContext = createContext<SplitControls | undefined>(undefined);
const AutoSplitContext = createContext<AutoSplitControls | undefined>(undefined);
const TextureContext = createContext<TextureControls | undefined>(undefined);
const ConnectorEditContext = createContext<ConnectorEditControls | undefined>(undefined);

export function AnalysisControlsProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const controls = useTopologyAnalysis();
  return <AnalysisContext.Provider value={controls}>{children}</AnalysisContext.Provider>;
}

export interface RepairControls extends ConservativeRepairControls {
  /**
   * Selects exactly `operations` and previews them as soon as the new plan is
   * ready — the inspector's "Fix this" for a category conservative repair
   * handles. The plan still decides: an operation it withholds is not built,
   * and the Auto repair section says why.
   */
  readonly previewOperations: (operations: readonly RepairOperation[]) => void;
}

export function RepairControlsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const controls = useConservativeRepair();
  const store = useWorkspaceStore();
  const { repair } = useWorkspaceState();
  const previewWhenPlanned = useRef(false);

  const previewOperations = useCallback(
    (operations: readonly RepairOperation[]): void => {
      previewWhenPlanned.current = true;
      store.setRepairSelection(operations);
    },
    [store],
  );

  // The selection change replans; the preview is started from the plan that
  // results, never from the one that was on screen when the button was pressed.
  const { previewRepair } = controls;
  useEffect(() => {
    if (!previewWhenPlanned.current) return;
    if (repair.planState === RepairPlanState.Planning) return;
    previewWhenPlanned.current = false;
    if (repair.planState === RepairPlanState.Ready && repair.plan?.noOp === false) previewRepair();
  }, [previewRepair, repair.plan, repair.planState]);

  const value = useMemo<RepairControls>(
    () => ({ ...controls, previewOperations }),
    [controls, previewOperations],
  );
  return <RepairContext.Provider value={value}>{children}</RepairContext.Provider>;
}

export function HoleFillControlsProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const controls = useHoleFillWorkflow();
  return <HoleFillContext.Provider value={controls}>{children}</HoleFillContext.Provider>;
}

/**
 * The Split & Connect controller. It starts no automatic work; it is here so
 * the panel, the viewport's arrow, the HUD and the inspector share ONE cut.
 */
export function SplitControlsProvider({
  children,
  autoSplit,
}: {
  readonly children: ReactNode;
  /** Test seam only: replaces the one thing Auto Split would reach the network with. */
  readonly autoSplit?: AutoSplitOptions;
}): ReactNode {
  const controls = useSplitWorkflow();
  return (
    <SplitContext.Provider value={controls}>
      <AutoSplitControlsProvider
        split={controls}
        {...(autoSplit === undefined ? {} : { options: autoSplit })}
      >
        {children}
      </AutoSplitControlsProvider>
    </SplitContext.Provider>
  );
}

/**
 * The Auto Split controller. It starts NOTHING by itself — no analysis, no request, no render — until
 * the user has chosen a model type, accepted the disclosure and pressed Find parts. It sits inside the
 * split provider because a suggestion is only ever a setting of the manual split's own controls.
 */
function AutoSplitControlsProvider({
  split,
  options,
  children,
}: {
  readonly split: SplitControls;
  readonly options?: AutoSplitOptions;
  readonly children: ReactNode;
}): ReactNode {
  const controls = useAutoSplit(split, options);
  return <AutoSplitContext.Provider value={controls}>{children}</AutoSplitContext.Provider>;
}

/**
 * The Surface Texture controller: one selection, one set of settings, shared by
 * the panel, the viewport, the HUD and the inspector.
 */
export function TextureControlsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const controls = useTextureWorkflow();
  return <TextureContext.Provider value={controls}>{children}</TextureContext.Provider>;
}

/**
 * The connector editor's controller: ONE draft, ONE candidate and ONE undo for the whole application, so the editor can be shown in any
 * workspace without each copy holding its own. It starts no work by itself; it holds a draft and releases the candidate it made.
 */
export function ConnectorEditControlsProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const controls = useConnectorEdit();
  return <ConnectorEditContext.Provider value={controls}>{children}</ConnectorEditContext.Provider>;
}

/** All of them, in the order their automatic work depends on. */
/**
 * Keeps the page's list of connector joints in step with the worker, once for the whole application. It renders nothing: a hook that
 * starts a read on every revision belongs in exactly one place, for the reason each controller above does.
 */
function JointSync(): ReactNode {
  useJointSync();
  return null;
}

export function WorkflowControllersProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <AnalysisControlsProvider>
      <JointSync />
      <RepairControlsProvider>
        <HoleFillControlsProvider>
          <SplitControlsProvider>
            <TextureControlsProvider>
              <ConnectorEditControlsProvider>{children}</ConnectorEditControlsProvider>
            </TextureControlsProvider>
          </SplitControlsProvider>
        </HoleFillControlsProvider>
      </RepairControlsProvider>
    </AnalysisControlsProvider>
  );
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} must be used inside its provider.`);
  return value;
}

export function useAnalysisControls(): TopologyAnalysisControls {
  return required(useContext(AnalysisContext), 'useAnalysisControls');
}

export function useRepairControls(): RepairControls {
  return required(useContext(RepairContext), 'useRepairControls');
}

export function useHoleFillControls(): HoleFillControls {
  return required(useContext(HoleFillContext), 'useHoleFillControls');
}

export function useSplitControls(): SplitControls {
  return required(useContext(SplitContext), 'useSplitControls');
}

export function useAutoSplitControls(): AutoSplitControls {
  return required(useContext(AutoSplitContext), 'useAutoSplitControls');
}

export function useConnectorEditControls(): ConnectorEditControls {
  return required(useContext(ConnectorEditContext), 'useConnectorEditControls');
}

export function useTextureControls(): TextureControls {
  return required(useContext(TextureContext), 'useTextureControls');
}

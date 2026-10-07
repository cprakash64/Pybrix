import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { focusableWithin } from './focus-trap';

/** The widths below which each panel stops docking and becomes a drawer. */
export const TOOL_DRAWER_QUERY = '(width < 900px)';
export const INSPECTOR_DRAWER_QUERY = '(width < 1200px)';

/**
 * Whether a media query matches, kept current as the window crosses it.
 *
 * Subscribes to the query's own `change` event, so a resize that stays within
 * one tier costs nothing; only crossing a breakpoint re-renders.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return (): void => {
        list.removeEventListener('change', notify);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Which drawer, if any, is open AS A MODAL at the current width. */
export type ModalDrawer = 'tool' | 'inspector';

/**
 * Which shell surfaces are open.
 *
 * LAYOUT STATE, NOT WORKSPACE STATE. Whether the inspector is collapsed says
 * nothing about the model, the document or any operation, so it lives in React
 * rather than in `WorkspaceStore` — the store is framework-free and describes
 * geometry sessions, and a panel toggle stored there would re-notify every
 * subscriber in the application for a change none of them care about.
 *
 * THREE INDEPENDENT FLAGS, because they apply at different widths:
 *
 *   - `inspectorCollapsed` is the DOCKED inspector's rail state (≥ 1200 px).
 *   - `inspectorDrawerOpen` is the OVERLAY inspector below 1200 px.
 *   - `toolDrawerOpen` is the OVERLAY tool panel below 900 px.
 *
 * CSS decides which one is in force at the current width; React never reads the
 * viewport size, so a resize costs no render. The two drawers are mutually
 * exclusive: opening one closes the other, so a phone never shows two sheets
 * stacked over a viewport it can no longer see.
 */
export interface ShellLayout {
  readonly inspectorCollapsed: boolean;
  readonly setInspectorCollapsed: (collapsed: boolean) => void;
  readonly inspectorDrawerOpen: boolean;
  readonly toolDrawerOpen: boolean;
  readonly toggleInspectorDrawer: () => void;
  readonly toggleToolDrawer: () => void;
  /**
   * Makes sure the tool panel can be seen: opens it as a drawer where it is
   * one, and otherwise only closes an inspector drawer that would cover it.
   * Used when a command elsewhere switches workspace, so the workspace it
   * switched to is not left behind a closed drawer.
   */
  readonly showToolPanel: () => void;
  readonly closeDrawers: () => void;
  /**
   * The drawer that is open AND is a drawer at this width. A docked panel is
   * never modal: at desktop widths the same open flag changes nothing, and
   * making the docked inspector a dialog would trap focus inside a panel
   * that sits beside the viewport rather than over it.
   */
  readonly modalDrawer: ModalDrawer | undefined;
}

const ShellLayoutContext = createContext<ShellLayout | undefined>(undefined);

export function ShellLayoutProvider({ children }: { readonly children: ReactNode }): ReactNode {
  // COLLAPSED BY DEFAULT: a fresh session gives the viewport the width. The flag is
  // session state only — nothing is persisted, so an old stored preference can
  // never force the panel open or shut.
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [toolDrawerOpen, setToolDrawerOpen] = useState(false);
  const toolIsDrawer = useMediaQuery(TOOL_DRAWER_QUERY);
  const inspectorIsDrawer = useMediaQuery(INSPECTOR_DRAWER_QUERY);
  const modalDrawer: ModalDrawer | undefined =
    toolDrawerOpen && toolIsDrawer
      ? 'tool'
      : inspectorDrawerOpen && inspectorIsDrawer
        ? 'inspector'
        : undefined;
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * Records what held focus when a drawer was asked to open. Read HERE, in the
   * click, because the next render makes the top bar inert and the browser
   * then drops focus from the toggle before any effect could see it.
   */
  const rememberOpener = useCallback((): void => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, []);

  const toggleInspectorDrawer = useCallback((): void => {
    rememberOpener();
    setToolDrawerOpen(false);
    setInspectorDrawerOpen((open) => !open);
  }, [rememberOpener]);

  const toggleToolDrawer = useCallback((): void => {
    rememberOpener();
    setInspectorDrawerOpen(false);
    setToolDrawerOpen((open) => !open);
  }, [rememberOpener]);

  const showToolPanel = useCallback((): void => {
    if (!toolIsDrawer) {
      setInspectorDrawerOpen(false);
      return;
    }
    // Only the FIRST drawer to open records the opener; moving from the
    // inspector drawer to this one keeps the control that opened the first.
    if (!toolDrawerOpen && !inspectorDrawerOpen) rememberOpener();
    setInspectorDrawerOpen(false);
    setToolDrawerOpen(true);
  }, [inspectorDrawerOpen, rememberOpener, toolDrawerOpen, toolIsDrawer]);

  const closeDrawers = useCallback((): void => {
    setInspectorDrawerOpen(false);
    setToolDrawerOpen(false);
  }, []);

  // Esc closes an open drawer. Menus handle their own Esc first and stop it,
  // so one press closes the innermost surface rather than everything at once.
  useEffect(() => {
    if (!inspectorDrawerOpen && !toolDrawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      closeDrawers();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeDrawers, inspectorDrawerOpen, toolDrawerOpen]);

  /*
   * FOCUS GOES IN WHEN A DRAWER BECOMES MODAL, AND BACK WHEN IT STOPS.
   *
   * The opener is whatever held focus at that moment — the top-bar toggle, in
   * practice — and it gets focus back however the drawer closes: Esc, the
   * scrim, its own Close button, or the window widening until it docks.
   */
  useEffect(() => {
    if (modalDrawer === undefined) return undefined;
    const root = document.getElementById(modalDrawer === 'tool' ? 'tool-panel' : 'inspector');
    if (root !== null) (focusableWithin(root)[0] ?? root).focus();
    return (): void => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected === true) opener.focus();
    };
  }, [modalDrawer]);

  const value = useMemo<ShellLayout>(
    () => ({
      inspectorCollapsed,
      setInspectorCollapsed,
      inspectorDrawerOpen,
      toolDrawerOpen,
      toggleInspectorDrawer,
      toggleToolDrawer,
      showToolPanel,
      closeDrawers,
      modalDrawer,
    }),
    [
      modalDrawer,
      closeDrawers,
      showToolPanel,
      inspectorCollapsed,
      inspectorDrawerOpen,
      toggleInspectorDrawer,
      toggleToolDrawer,
      toolDrawerOpen,
    ],
  );

  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>;
}

export function useShellLayout(): ShellLayout {
  const layout = useContext(ShellLayoutContext);
  if (layout === undefined) {
    throw new Error('useShellLayout must be used inside <ShellLayoutProvider>.');
  }
  return layout;
}

export interface DismissableMenu {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
  /** Attach to the element that contains BOTH the trigger and the menu. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Open/close state for a popover menu that closes on Esc, on a pointer press
 * outside it, and when focus leaves it.
 *
 * Esc is marked handled so the drawer listener above does not also close the
 * drawer the menu sits in, and returns focus to the trigger — the container's
 * element carrying `aria-expanded`. The triggers are disclosures and carry no
 * `aria-haspopup`; see `TopBar.tsx`.
 */
export function useDismissableMenu(): DismissableMenu {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback((): void => {
    setOpen(false);
  }, []);
  const toggle = useCallback((): void => {
    setOpen((current) => !current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && container.contains(event.target))
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      const trigger = containerRef.current?.querySelector<HTMLElement>('[aria-expanded]');
      trigger?.focus();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  return { open, toggle, close, containerRef };
}

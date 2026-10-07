import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * THE WORKSPACE ACTION REGION, and where everything else goes — WORKSPACE-UX-03.
 *
 * Every workspace pins its primary action to the bottom of the tool panel's one
 * scroller. Every pixel that region takes is taken from the controls above it,
 * and on a short window the scroller is 140 px tall: a footer that grows with
 * its state leaves nothing. v0.6.0's release qualification stopped on exactly
 * that, three times over — after a repair was applied Undo sat under the
 * footer, after a split the footer was taller than the scroll area, and after
 * a texture 19 px of content was left.
 *
 * THE CONTRACT, the same in Repair, Convert, Split and Texture:
 *
 *   - The action region holds the ACTION ROW and AT MOST ONE LINE about it —
 *     progress, a state, a failure's headline, or the reason the action cannot
 *     be pressed. Whichever applies first; never two.
 *   - A RESULT IS CONTENT. What was repaired, which pieces a split made, the
 *     file an export wrote, the full text of a failure, an explanation behind
 *     ⓘ, and any control that is not the immediate action — all of it scrolls.
 *   - THE CAP IS STRUCTURAL AS WELL. `.action-footer` is limited to
 *     `--action-footer-max`; the action row never shrinks, so a line that ran
 *     long is clipped before a button is.
 *   - THE SCROLLER'S `scroll-padding-bottom` IS THE SAME LENGTH, so focus, Tab
 *     and scroll-into-view land a control above the region, not behind it.
 *
 * These components are how a workspace states that it follows the contract; a
 * test asserts each footer is one and that no result lives inside it.
 */

export function ActionFooter({
  testId,
  className,
  children,
}: {
  readonly testId: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={`convert-footer action-footer${className === undefined ? '' : ` ${className}`}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * The one line. ALWAYS ONE LINE: it truncates rather than wraps, and carries
 * the full text as a tooltip. A sentence that matters in full belongs in the
 * scrolling content, not here.
 */
export function ActionFooterLine({
  children,
  testId,
  tone = 'state',
  title,
}: {
  readonly children: ReactNode;
  readonly testId?: string;
  /** `failure` marks a headline whose full message is in the content above. */
  readonly tone?: 'state' | 'failure';
  readonly title?: string;
}): ReactNode {
  return (
    <p
      className={`action-footer__line action-footer__line--${tone}`}
      {...(title === undefined ? {} : { title })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {children}
    </p>
  );
}

/** The tool panel's one scroller, for an element inside it. */
function toolPanelScroller(element: HTMLElement | null): HTMLElement | undefined {
  const scroller = element?.closest('.tool-panel__body');
  return scroller instanceof HTMLElement ? scroller : undefined;
}

/**
 * Whether the element is on screen at all. Workspaces stay mounted while
 * hidden, and a hidden one must not move the scroller the visible one is using.
 */
const isShown = (element: HTMLElement): boolean => element.getClientRects().length > 0;

/**
 * Brings the END of the scrolling content — the block directly above the
 * action region — into view when `key` becomes a new defined value.
 *
 * THE PANEL'S OWN SCROLLER, SET DIRECTLY, never `scrollIntoView`: that also
 * scrolls every clipped ancestor and moves the whole application shell.
 */
export function useRevealAtEnd<T extends HTMLElement>(
  key: string | undefined,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (key === undefined) return;
    const element = ref.current;
    if (element === null || !isShown(element)) return;
    const scroller = toolPanelScroller(element);
    if (scroller !== undefined) scroller.scrollTop = scroller.scrollHeight;
  }, [key]);
  return ref;
}

/**
 * Brings an element's top to the top of the scrolling content, once, when it
 * mounts — a result card announcing itself. Same scroller, same reasoning.
 */
export function useRevealOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || !isShown(element)) return;
    const scroller = toolPanelScroller(element);
    if (scroller === undefined) return;
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - 8;
  }, []);
  return ref;
}

/**
 * THE OUTCOME BLOCK: the last thing in a workspace's scrolling content, so it
 * sits directly above the action region when the panel is scrolled to its end.
 *
 * It holds what the footer may not: the full text of a failure, a result card,
 * an explanation behind ⓘ. `revealKey` names what is currently in it; when
 * that changes to something new the block is scrolled into view, so the line
 * in the footer and the detail it refers to appear together.
 */
export function WorkspaceOutcome({
  revealKey,
  children,
}: {
  readonly revealKey: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const ref = useRevealAtEnd<HTMLDivElement>(revealKey);
  return (
    <div ref={ref} className="workspace-outcome">
      {children}
    </div>
  );
}

/**
 * A NEUTRAL RESULT in full — a decision, not a failure. `role="status"`, never an alert: "Pybrix
 * left these areas unchanged" is information the user asked for, and announcing it as an error
 * would teach people to read a safety feature as a fault.
 */
export function OutcomeNote({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p className="workspace-outcome__note" role="status" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * A failure, in full. `role="alert"` lives HERE and only here: the footer's
 * headline is the same event, and announcing it twice would be noise.
 */
export function OutcomeAlert({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p className="workspace-outcome__alert" role="alert" data-testid={testId}>
      {children}
    </p>
  );
}

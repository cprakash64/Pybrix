import type { KeyboardEvent } from 'react';

const FOCUSABLE =
  'button, summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The controls a keyboard user can actually reach inside `root`, in order.
 *
 * VISIBILITY IS PART OF THE TEST. A drawer holds panels that are present but
 * `hidden` — another workspace's controls, a collapsed section — and a trap
 * that counted them would wrap focus onto something that is not on screen.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.closest('[hidden], [inert]') === null &&
      (element.closest('details:not([open])') === null || element.tagName === 'SUMMARY') &&
      element.tabIndex !== -1 &&
      element.getClientRects().length > 0,
  );
}

/**
 * Keeps Tab and Shift+Tab inside `root` by wrapping at either end.
 *
 * Read at the moment Tab is pressed rather than cached, because a drawer's
 * contents change while it is open — a section collapses, a workspace panel
 * adds a control. The same approach as the Export / Convert dialog.
 */
export function keepTabWithin(event: KeyboardEvent<HTMLElement>, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = focusableWithin(root);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !root.contains(active);
  if (event.shiftKey && (active === first || active === root || outside)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

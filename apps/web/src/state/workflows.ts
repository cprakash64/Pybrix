/**
 * The five workflows CAD Fixer will offer.
 *
 * `implemented` is the single source of truth for whether a workflow can be
 * entered. The navigation renders from this list, so a workflow cannot appear
 * enabled until it genuinely exists.
 *
 * REPAIR IS THE FIRST ONE TO FLIP, and its summary was rewritten when it did.
 * The old wording promised closing openings and resolving non-manifold geometry;
 * conservative repair does neither, and a navigation label that describes a
 * capability the screen behind it does not have is the first false claim a user
 * meets. See docs/repair/REPAIR_POLICY.md.
 */

export const WorkflowId = {
  Repair: 'repair',
  Convert: 'convert',
  Split: 'split',
  Texture: 'texture',
  Hollow: 'hollow',
} as const;

export type WorkflowId = (typeof WorkflowId)[keyof typeof WorkflowId];

export interface WorkflowDescriptor {
  readonly id: WorkflowId;
  readonly label: string;
  /** One line describing the eventual capability. Written in the future tense. */
  readonly summary: string;
  readonly implemented: boolean;
}

export const WORKFLOWS: readonly WorkflowDescriptor[] = Object.freeze([
  {
    id: WorkflowId.Repair,
    label: 'Repair',
    summary:
      'Safe automatic repair: remove duplicate and degenerate triangles, unify winding, separate pinched vertices and fill simple openings — only where each can be checked.',
    implemented: true,
  },
  {
    /*
     * FLIPPED IN STAGE 4A-2B3, and the summary was rewritten with it for the
     * same reason Repair's was: the old line promised translation between three
     * formats while the product could write exactly one of them.
     *
     * UI-03 shortened it to the reference's shape and kept it true: the
     * reference says "one file or a whole batch", and CAD Fixer holds one
     * document and writes one format per export, so it says "one file at a
     * time". What survives is answered per conversion by the workspace's
     * report, not promised here.
     */
    id: WorkflowId.Convert,
    label: 'Convert',
    summary: 'Export to other formats, one file at a time.',
    implemented: true,
  },
  {
    /*
     * UI-04 took the reference's shape without its word "printable": nothing in
     * CAD Fixer checks that a piece will print, and no interface text may say it.
     */
    id: WorkflowId.Split,
    label: 'Split',
    summary: 'Cut the model into parts, with optional connectors.',
    implemented: true,
  },
  {
    /*
     * UI-05 took the reference's tone and kept it exact: the engine raises OR
     * cuts in, and only on a flat surface.
     */
    id: WorkflowId.Texture,
    label: 'Texture',
    summary: 'Emboss or engrave a pattern on a flat surface.',
    implemented: true,
  },
  {
    id: WorkflowId.Hollow,
    label: 'Hollow',
    summary: 'Hollow solid models and place drainage holes.',
    implemented: false,
  },
]);

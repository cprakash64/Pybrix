import { AnalyzeErrorCode } from '@cadfixer/auto-split-contract';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from '@cadfixer/auto-split';
import {
  AutoSplitPhase,
  LocalErrorCode,
  ModelKind,
  type AutoSplitErrorView,
} from './auto-split-session';

/**
 * ALL OF AUTO SPLIT'S COPY, in one file, for the reason the repair and hole-fill copy lives in one:
 * a sentence written inline in a component is a sentence two screens can disagree about.
 *
 * WHAT IT MAY CLAIM. "AI-assisted part detection with editable split suggestions" and nothing
 * stronger. It never says a suggestion is correct, accurate or complete, never shows a number that
 * reads as confidence, never says Pybrix separates every part, and never uses research vocabulary. A
 * suggestion is something to REVIEW; Preview shows it and only Apply changes the model.
 *
 * The switches over statuses, reasons, phases and codes are exhaustive with no `default`, so a new
 * value is a compile error here rather than a blank string on screen.
 */

export const AUTO_SPLIT_COPY = {
  name: 'Auto Split',
  badge: 'Beta',
  tagline: 'AI finds likely parts and prepares editable splits for you to review.',
  tabsLabel: 'Split mode',
  autoTab: 'Auto Split',
  manualTab: 'Manual Split',
  /** The claim the product may make, and the only one. */
  claim: 'AI-assisted part detection with editable split suggestions.',

  disclosureHeading: 'Before Auto Split looks at your model',
  disclosure:
    'Auto Split uses AI to identify parts. Your original 3D file stays on your device. Auto Split sends six rendered views and limited model metadata for AI analysis. Repair and Manual Split remain local.',
  disclosureContinue: 'Continue',
  disclosureCancel: 'Cancel',

  kindHeading: 'What kind of model is this?',
  kindCharacter: 'Character / Human',
  kindVehicle: 'Vehicle',
  kindOther: 'Other',
  kindHint: 'Choose one so Auto Split looks for the right parts.',
  characterScope: 'Looks for the head and the left and right arms.',
  vehicleScope: 'Looks for wheels, wheel groups, the cab, the bed or cargo area, and the body.',
  otherHeading: 'Auto Split can’t find parts in this kind of model yet.',
  otherBody: 'Manual Split works on any model: choose a plane, preview the cut, then apply it.',
  openManual: 'Open Manual Split',

  analyze: 'Find parts',
  reanalyze: 'Re-analyze current part',
  currentPart: 'Part being analyzed',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  startOver: 'Start over',
  waitHint: 'This can take from several seconds to a minute or more. You can cancel at any time.',
  localNote: 'Your model is not changed while Auto Split looks at it.',

  resultsHeading: 'Suggested parts',
  noSuggestions: 'Auto Split did not find parts it could suggest for this model.',
  show: 'Show on model',
  hide: 'Hide from model',
  preview: 'Preview',
  edit: 'Edit',
  previewSelection: 'Preview selection',
  oneAtATime: 'Review one suggestion at a time. Nothing changes until you apply a preview.',

  componentsHeading: 'Components in this suggestion',
  componentsHint: 'Add or remove components, then preview the selection.',
  reviewSelection: 'Review selection',

  needsRepairHeading: 'Part found, but this model needs Repair before it can be split.',
  runRepair: 'Open Repair',
  needsRepairOther: 'Manual Split can’t split it either until its surface is closed.',

  stale: 'The model changed after this analysis, so these suggestions are out of date.',
  afterApply:
    'The split was applied. These suggestions describe the earlier model. Re-analyze looks only at the part now shown, not at the rest of the original model.',
  approximateCut:
    'Manual Split can’t place this cut exactly, so the nearest cut it can place was loaded. Check it in the preview.',
  noModel: 'Load a model to use Auto Split.',
  unsafeCut: 'This suggested cut isn’t safe on this model. Adjust the cut or use Manual Split.',
  unitlessNote:
    'This file doesn’t say what its units are, so connectors stay locked until you choose how to read them.',
  componentsNoConnectors: 'Components are already separate shells, so there is nothing to connect.',
} as const;

export const MODEL_KIND_ORDER: readonly ModelKind[] = Object.freeze([
  ModelKind.Character,
  ModelKind.Vehicle,
  ModelKind.Other,
]);

export function describeModelKind(kind: ModelKind): string {
  switch (kind) {
    case ModelKind.Character:
      return AUTO_SPLIT_COPY.kindCharacter;
    case ModelKind.Vehicle:
      return AUTO_SPLIT_COPY.kindVehicle;
    case ModelKind.Other:
      return AUTO_SPLIT_COPY.kindOther;
  }
}

export function describeScope(kind: ModelKind): string {
  switch (kind) {
    case ModelKind.Character:
      return AUTO_SPLIT_COPY.characterScope;
    case ModelKind.Vehicle:
      return AUTO_SPLIT_COPY.vehicleScope;
    case ModelKind.Other:
      return AUTO_SPLIT_COPY.otherBody;
  }
}

/** What a suggestion would do, in plain words. */
export function describeOperation(operation: SuggestionOperation): string {
  switch (operation) {
    case SuggestionOperation.Plane:
      return 'Cut';
    case SuggestionOperation.Component:
      return 'Separate part';
    case SuggestionOperation.None:
      return '—';
  }
}

export interface SuggestionStatusView {
  readonly label: string;
  /** For a style hook only; the label carries the meaning, so nothing depends on colour. */
  readonly tone: 'ready' | 'review' | 'unavailable' | 'repair';
}

/**
 * The status the list shows. A suggestion the local gate cannot execute on this source says so FIRST:
 * a clean-looking "Suggested" beside a disabled Preview would be a promise the model cannot keep.
 */
export function describeStatus(suggestion: Suggestion, sourceReady: boolean): SuggestionStatusView {
  if (suggestion.status === SuggestionStatus.Unavailable)
    return { label: 'No safe split found', tone: 'unavailable' };
  if (!sourceReady) return { label: 'Repair model first', tone: 'repair' };
  switch (suggestion.status) {
    case SuggestionStatus.Suggested:
      return { label: 'Suggested', tone: 'ready' };
    case SuggestionStatus.NeedsAdjustment:
      return suggestion.operation === SuggestionOperation.Component
        ? { label: AUTO_SPLIT_COPY.reviewSelection, tone: 'review' }
        : { label: 'Review cut', tone: 'review' };
  }
}

/**
 * Why a suggestion has the status it has, as a sentence. Never a number. When the model cannot be split
 * yet the sentence says that instead: "found a clear match, preview it" beside a disabled Preview would
 * be a promise the part cannot keep.
 */
export function describeReason(reason: SuggestionReason, sourceReady = true): string {
  if (
    !sourceReady &&
    reason !== SuggestionReason.CutDoesNotIsolate &&
    reason !== SuggestionReason.FusedIntoBody &&
    reason !== SuggestionReason.WholeModel &&
    reason !== SuggestionReason.NotLocated
  )
    return 'Found, but it can be previewed only once the model can be split.';
  switch (reason) {
    case SuggestionReason.Clear:
      return 'Found a clear match. Preview it before applying.';
    case SuggestionReason.ReviewCut:
      return 'This cut is a starting point. Check where it falls before applying.';
    case SuggestionReason.ReviewSelection:
      return 'More than one component could be this part. Check the selection.';
    case SuggestionReason.BetaCut:
      return 'Beta: the cab and the bed are joined, so this is a suggested cut between them.';
    case SuggestionReason.CutDoesNotIsolate:
      return 'A single flat cut would not separate this part from the rest.';
    case SuggestionReason.FusedIntoBody:
      return 'This part is built into the body, so it can’t be taken out without a cut Auto Split can’t suggest.';
    case SuggestionReason.WholeModel:
      return 'The match is the whole model, so nothing would be left to separate it from.';
    case SuggestionReason.NotLocated:
      return 'Auto Split could not tell where this part is.';
  }
}

/** Closed-solid reasons from the local gate, in words. */
export function describeSourceReason(reason: string): string {
  switch (reason) {
    case 'OPEN_BOUNDARIES':
      return 'the surface still has open boundaries';
    case 'NON_MANIFOLD':
      return 'it has non-manifold edges or vertices';
    case 'WINDING_CONFLICT':
      return 'its triangles don’t agree which side is outside';
    case 'DEGENERATE_OR_DUPLICATE':
      return 'it has zero-area or repeated triangles';
    default:
      return 'its surface is not a closed solid';
  }
}

/** Repair's conservative operations address winding and degenerate or duplicate triangles, and only those. */
export function repairCanHelp(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => reason === 'WINDING_CONFLICT' || reason === 'DEGENERATE_OR_DUPLICATE')
  );
}

export function describeSourceNotReady(reasons: readonly string[]): string {
  const facts = reasons.map(describeSourceReason);
  return facts.length === 0 ? '' : `This model isn’t ready to split: ${facts.join('; ')}.`;
}

export function describePhase(phase: AutoSplitPhase, note: string): string {
  switch (phase) {
    case AutoSplitPhase.Idle:
      return '';
    case AutoSplitPhase.PreparingViews:
      return note === '' ? 'Rendering six views of your model on this device…' : note;
    case AutoSplitPhase.Analyzing:
      return note === '' ? 'Finding parts…' : note;
    case AutoSplitPhase.SuggestionsReady:
      return 'Suggestions are ready to review.';
    case AutoSplitPhase.Previewing:
      return 'Previewing — not applied.';
    case AutoSplitPhase.Applying:
      return 'Applying…';
    case AutoSplitPhase.Error:
      return 'Auto Split could not finish.';
    case AutoSplitPhase.Cancelled:
      return 'Cancelled. Your model was not changed.';
    case AutoSplitPhase.SourceNotReady:
      return AUTO_SPLIT_COPY.needsRepairHeading;
  }
}

/** What the user can do about a failure. */
export interface ErrorGuidance {
  readonly message: string;
  /** True when "Try again" is a sensible next step. */
  readonly canRetry: boolean;
  readonly detail: string | undefined;
}

export function describeError(error: AutoSplitErrorView): ErrorGuidance {
  const wait =
    error.retryAfterSeconds === undefined
      ? undefined
      : `Try again in about ${formatWait(error.retryAfterSeconds)}.`;
  switch (error.code) {
    case AnalyzeErrorCode.RateLimited:
    case AnalyzeErrorCode.Busy:
      return { message: error.message, canRetry: true, detail: wait };
    case AnalyzeErrorCode.AtCapacity:
      // A service-wide ceiling: the person did nothing, and is told no more than that. No wait is quoted,
      // because the wait says something about the ceiling.
      return {
        message: error.message,
        canRetry: true,
        detail: 'Repair and Manual Split are not affected.',
      };
    case AnalyzeErrorCode.UnsupportedProtocol:
      return { message: error.message, canRetry: false, detail: undefined };
    case AnalyzeErrorCode.UnsupportedMode:
      return {
        message: error.message,
        canRetry: false,
        detail: 'Manual Split works on any model.',
      };
    case LocalErrorCode.SourceChanged:
    case LocalErrorCode.LocalFailure:
    case AnalyzeErrorCode.InvalidRequest:
    case AnalyzeErrorCode.RawGeometryRejected:
    case AnalyzeErrorCode.PayloadTooLarge:
    case AnalyzeErrorCode.ProviderUnavailable:
    case AnalyzeErrorCode.ProviderTimeout:
    case AnalyzeErrorCode.ProviderInvalidResponse:
    case AnalyzeErrorCode.Cancelled:
    case AnalyzeErrorCode.NotFound:
    case AnalyzeErrorCode.MethodNotAllowed:
    case AnalyzeErrorCode.Internal:
    case AnalyzeErrorCode.Network:
      return {
        message: error.message,
        canRetry: true,
        detail: 'Your model was not changed.',
      };
  }
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${String(Math.max(1, Math.round(seconds)))} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/** Every string above, flattened, for the banned-wording test. */
export function allAutoSplitCopy(): readonly string[] {
  const phrases: string[] = [...Object.values(AUTO_SPLIT_COPY)];
  for (const kind of MODEL_KIND_ORDER) phrases.push(describeModelKind(kind), describeScope(kind));
  for (const operation of Object.values(SuggestionOperation))
    phrases.push(describeOperation(operation));
  for (const reason of Object.values(SuggestionReason))
    phrases.push(describeReason(reason), describeReason(reason, false));
  for (const phase of Object.values(AutoSplitPhase)) phrases.push(describePhase(phase, ''));
  for (const code of [
    'OPEN_BOUNDARIES',
    'NON_MANIFOLD',
    'WINDING_CONFLICT',
    'DEGENERATE_OR_DUPLICATE',
    'SOMETHING_ELSE',
  ])
    phrases.push(describeSourceReason(code));
  phrases.push(describeSourceNotReady(['OPEN_BOUNDARIES', 'WINDING_CONFLICT']));
  return phrases;
}

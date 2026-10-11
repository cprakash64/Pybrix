import { useCallback, useState, type DragEvent, type ReactNode } from 'react';
import { SUPPORTED_EXTENSIONS } from '@cadfixer/file-formats';
import { ImportState } from '../state/workspace-store';
import { useWorkspaceState } from '../state/store-context';
import { describeImplementedFormats, useFileIntake } from './FileIntake';
import { Icon } from './shell/Icon';

/**
 * The viewport as a file drop target, and everything it says about intake.
 *
 * THE WHOLE VIEWPORT ACCEPTS A DROP, and it does so without covering the
 * canvas: the handlers sit on an ancestor, so drag events bubble up to them
 * while orbit, pan, zoom and picking reach the canvas exactly as before. The
 * cards drawn over the viewport take pointer events only where they are.
 *
 * WHAT THIS COMPONENT DOES NOT DO: it does not read file contents or screen
 * them. Both routes in — this drop and the top bar's Open button — go through
 * `useFileIntake`, the one handler that screens a file and hands it to the
 * import service.
 */
export function ImportDropZone({ children }: { readonly children: ReactNode }): ReactNode {
  const { importProgress, geometrySessionLost, model } = useWorkspaceState();
  const { handleFiles, openPicker, isImporting, cancelImport } = useFileIntake();
  const [isDragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      event.preventDefault();
      setDragging(false);
      handleFiles([...event.dataTransfer.files]);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    // Required for the element to be a valid drop target at all.
    event.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    // `dragleave` also fires when the pointer crosses onto a child element, so
    // dropping the highlight unconditionally makes it flicker. Only clear it
    // when the pointer has genuinely left the zone.
    const movingTo = event.relatedTarget;
    if (movingTo instanceof Node && event.currentTarget.contains(movingTo)) return;
    setDragging(false);
  }, []);

  const percent = Math.round(importProgress.fraction * 100);
  const detail = describeImportDetail(importProgress.note);

  return (
    <section
      className="import"
      aria-label="Import a model"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      data-testid="drop-zone"
      data-dragging={isDragging ? 'true' : undefined}
    >
      {children}

      {model === undefined && !isImporting ? (
        <div className="import__empty">
          <div className="import__card">
            <span className="import__card-icon">
              <Icon name="upload" size={26} />
            </span>
            <p className="import__headline">Drop a 3D model to get started</p>
            <p className="import__formats">
              {SUPPORTED_EXTENSIONS.map((extension) =>
                extension.replace('.', '').toUpperCase(),
              ).join(' · ')}
            </p>
            <p className="import__tagline" data-testid="drop-tagline">
              Repair, convert, split and texture — locally in your browser.
            </p>
            {/* Drag and drop is never the only route in: this button and the top
                bar's Open button keep intake reachable by keyboard and by
                assistive technology. */}
            <button
              type="button"
              className="primary-action import__browse"
              onClick={openPicker}
              disabled={isImporting}
              data-testid="empty-browse-button"
            >
              <Icon name="open" size={16} />
              <span>Browse files</span>
            </button>
            <p className="import__detail">
              Opens {describeImplementedFormats()} ({SUPPORTED_EXTENSIONS.join(', ')}), geometry
              only. OBJ faces must be triangles, and OBJ material libraries and 3MF colours,
              materials and textures are not loaded. 3MF files that spread a model across several
              model parts are read; a 3MF that requires any other extension is refused with the
              reason. Your original 3D file is read on this device and is not uploaded.
            </p>
          </div>
        </div>
      ) : null}

      {isDragging ? (
        <div className="import__drag" aria-hidden="true">
          Release to import
        </div>
      ) : null}

      {geometrySessionLost !== undefined ? (
        <p className="import__lost" role="alert" data-testid="session-lost">
          The geometry session was lost: {geometrySessionLost} The model was held in memory by that
          worker and cannot be recovered. Open the file again to continue.
        </p>
      ) : null}

      {isImporting ? (
        <div
          className="import__progress"
          data-testid="import-progress"
          /*
           * THE WORKER'S OWN PHASE, as a symbol rather than as the copy beside
           * it.
           *
           * `describeImportDetail` deliberately maps a reader's internal note to
           * a sentence for a person, which means the phase itself stops being
           * observable from outside the moment it is rendered. Stage 6D-B2's
           * MF-P24 has to prove a cancel was requested AFTER inflation, and
           * proving that against display copy would make the proof drift the day
           * the wording changed. This carries the raw note — `parsing model`,
           * not `reading the model part` — so a test compares the SYMBOL the
           * reader emits. It is diagnostic metadata, never displayed, and
           * absent when the reader reports no note.
           */
          {...(importProgress.note === undefined ? {} : { 'data-phase': importProgress.note })}
        >
          <div className="import__progress-row">
            <span className="import__spinner" aria-hidden="true">
              <Icon name="loader" size={16} />
            </span>
            <span className="import__progress-text" data-testid="import-phase">
              {describePhase(importProgress.state)}
              {detail === undefined ? null : (
                <span className="import__progress-detail" data-testid="import-detail">
                  {' — '}
                  {detail}
                </span>
              )}
            </span>
            <span className="import__percent">{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Import progress: ${describePhase(importProgress.state)}${
              detail === undefined ? '' : ` — ${detail}`
            }`}
          />
          <button
            type="button"
            className="import__cancel"
            onClick={cancelImport}
            data-testid="cancel-import"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The codec's own note, in words for a person — or nothing.
 *
 * WHY A MAP RATHER THAN THE NOTE ITSELF. The notes are the readers' internal
 * vocabulary, and rendering one raw would put a word like `parsing model` on
 * screen because that is what a function happened to pass. Anything not listed
 * shows NOTHING: the phase label above it is already true on its own, and a
 * blank detail is better than an internal token.
 *
 * Only the notes that tell the user something the phase does not are listed.
 * "Decompressing" is the clearest case — a 3MF spends real time there, and
 * without this the interface says `Parsing geometry` while it inflates.
 */
function describeImportDetail(note: string | undefined): string | undefined {
  switch (note) {
    case 'reading package':
      return 'reading the archive';
    case 'decompressing':
      return 'decompressing';
    case 'parsing model':
      return 'reading the model part';
    case 'building document':
      return 'building parts';
    default:
      return undefined;
  }
}

export function describePhase(state: ImportState): string {
  switch (state) {
    case ImportState.Screening:
      return 'Checking file';
    case ImportState.Reading:
      return 'Reading file';
    case ImportState.Parsing:
      return 'Parsing geometry';
    case ImportState.Validating:
      return 'Validating structure';
    case ImportState.Ready:
      return 'Ready';
    case ImportState.Error:
      return 'Failed';
    case ImportState.Idle:
    default:
      return 'Idle';
  }
}

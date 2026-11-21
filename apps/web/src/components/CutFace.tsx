import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { JointOutline } from '@cadfixer/geometry-runtime';
import {
  cutView,
  outlinePath,
  pointerToCut,
  radiusInCut,
  toViewY,
  type CutView,
} from '../state/cut-face-view';
import type { DraftPin } from '../state/use-connector-edit';
import { NUDGE_MM } from '../state/use-connector-edit';

/**
 * THE FACE OF A CUT, WITH ITS CONNECTORS ON IT (Stage EC-6): the one place a connector is placed by looking at where it goes.
 *
 * The outline is the worker's description of the cut, drawn in the cut's own two axes. A connector is the pin's circle inside the
 * socket's dashed ring, both at the size the draft states, and it can be dragged, moved by the arrow keys (0.5 mm; Shift for five times
 * that) or taken out with Delete. THIS VIEW JUDGES NOTHING: it does not clamp a connector to the outline or mark one as too close to
 * another, because the worker alone knows what material is there and which spacing it will accept, and a second opinion drawn here would
 * one day disagree with it. A position is checked when the change is.
 */
export function CutFace({
  outline,
  mmPerCoordinate,
  pins,
  diameterMm,
  clearanceMm,
  selected,
  axisLabels,
  disabled,
  onSelect,
  onMove,
  onRemove,
}: {
  readonly outline: JointOutline;
  readonly mmPerCoordinate: number;
  readonly pins: readonly DraftPin[];
  readonly diameterMm: number;
  readonly clearanceMm: number;
  readonly selected: number | undefined;
  /** What to write against each direction of the picture, from the model's own axes (`+X`), or nothing when the worker did not say. */
  readonly axisLabels?: { readonly across: string; readonly along: string };
  readonly disabled: boolean;
  readonly onSelect: (index: number | undefined) => void;
  readonly onMove: (index: number, u: number, v: number) => void;
  readonly onRemove: (index: number) => void;
}): ReactNode {
  const svg = useRef<SVGSVGElement>(null);
  const view = useMemo(() => cutView(outline.bounds), [outline.bounds]);
  const [dragging, setDragging] = useState<
    { readonly index: number; readonly du: number; readonly dv: number } | undefined
  >(undefined);

  const pinRadius = radiusInCut(diameterMm / 2, mmPerCoordinate);
  const socketRadius = radiusInCut(diameterMm / 2 + clearanceMm, mmPerCoordinate);
  const step = NUDGE_MM / mmPerCoordinate;

  const pointer = (clientX: number, clientY: number): { u: number; v: number } | undefined => {
    const element = svg.current;
    if (element === null) return undefined;
    const rect = element.getBoundingClientRect();
    return pointerToCut(view, rect, clientX, clientY);
  };

  // A drag follows the pointer wherever it goes, including off the picture, until it is released.
  useEffect(() => {
    if (dragging === undefined) return undefined;
    const move = (event: globalThis.PointerEvent): void => {
      const at = pointerToCut(
        view,
        svg.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 },
        event.clientX,
        event.clientY,
      );
      if (at !== undefined) onMove(dragging.index, at.u + dragging.du, at.v + dragging.dv);
    };
    const end = (): void => {
      setDragging(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging, onMove, view]);

  const begin = (index: number, pin: DraftPin, event: PointerEvent<SVGGElement>): void => {
    if (disabled) return;
    event.preventDefault();
    onSelect(index);
    const at = pointer(event.clientX, event.clientY);
    setDragging({
      index,
      du: at === undefined ? 0 : pin.u - at.u,
      dv: at === undefined ? 0 : pin.v - at.v,
    });
  };

  const key = (index: number, pin: DraftPin, event: KeyboardEvent<SVGGElement>): void => {
    if (disabled) return;
    const amount = event.shiftKey ? step * 5 : step;
    switch (event.key) {
      case 'ArrowLeft':
        onMove(index, pin.u - amount, pin.v);
        break;
      case 'ArrowRight':
        onMove(index, pin.u + amount, pin.v);
        break;
      case 'ArrowUp':
        onMove(index, pin.u, pin.v + amount);
        break;
      case 'ArrowDown':
        onMove(index, pin.u, pin.v - amount);
        break;
      case 'Delete':
      case 'Backspace':
        onRemove(index);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const label = (index: number, pin: DraftPin): string =>
    `Connector ${String(index + 1)}, ${String(Number((pin.u * mmPerCoordinate).toFixed(2)))} mm across and ${String(Number((pin.v * mmPerCoordinate).toFixed(2)))} mm along. Arrow keys move it, Shift moves it further, Delete takes it out.`;

  return (
    <svg
      ref={svg}
      className="cut-face"
      viewBox={viewBoxOf(view)}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="The cut, with its connectors"
      data-testid="cut-face"
      data-dragging={dragging === undefined ? 'false' : 'true'}
    >
      <path className="cut-face__outline" d={outlinePath(outline)} fillRule="evenodd" />
      {axisLabels === undefined ? null : (
        <>
          {/* Written in the empty band beside the direction each names: across to the right, along above. */}
          <text
            className="cut-face__axis"
            x={outline.bounds.maxU + view.margin * 0.12}
            y={toViewY((outline.bounds.minV + outline.bounds.maxV) / 2)}
            fontSize={view.margin * 0.42}
            dominantBaseline="central"
            aria-hidden="true"
            data-testid="cut-face-axis-across"
          >
            {`→${axisLabels.across}`}
          </text>
          <text
            className="cut-face__axis"
            x={(outline.bounds.minU + outline.bounds.maxU) / 2}
            y={toViewY(outline.bounds.maxV) - view.margin * 0.5}
            fontSize={view.margin * 0.42}
            textAnchor="middle"
            dominantBaseline="central"
            aria-hidden="true"
            data-testid="cut-face-axis-along"
          >
            {`↑${axisLabels.along}`}
          </text>
        </>
      )}
      {pins.map((pin, index) => {
        const isSelected = selected === index;
        const y = toViewY(pin.v);
        return (
          <g
            // A pin has a name once it exists and none while it is only a draft; its place in the list is its identity until then.
            key={pin.pinId ?? `new-${String(index)}`}
            className={`cut-face__pin${isSelected ? ' cut-face__pin--selected' : ''}`}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={label(index, pin)}
            aria-disabled={disabled}
            data-testid={`cut-face-pin-${String(index)}`}
            data-u={pin.u}
            data-v={pin.v}
            onPointerDown={(event) => {
              begin(index, pin, event);
            }}
            onFocus={() => {
              onSelect(index);
            }}
            onKeyDown={(event) => {
              key(index, pin, event);
            }}
          >
            <circle className="cut-face__socket" cx={pin.u} cy={y} r={socketRadius} />
            <circle className="cut-face__body" cx={pin.u} cy={y} r={pinRadius} />
            <text
              className="cut-face__number"
              x={pin.u}
              y={y}
              fontSize={Math.max(
                Math.min(pinRadius * 1.3, view.height * 0.07),
                view.height * 0.025,
              )}
              textAnchor="middle"
              dominantBaseline="central"
              aria-hidden="true"
            >
              {index + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const viewBoxOf = (view: CutView): string =>
  `${String(view.x)} ${String(view.y)} ${String(view.width)} ${String(view.height)}`;

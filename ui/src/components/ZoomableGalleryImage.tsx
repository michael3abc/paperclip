import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

type Point = { x: number; y: number };
type View = Point & { scale: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 5;
const STEP = 1.25;

/** Zoom is relative to the fitted image, with pan bounded by the visible viewport. */
export function ZoomableGalleryImage({ src, alt }: { src: string; alt: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const viewRef = useRef<View>(FIT);
  const [view, setView] = useState<View>(FIT);
  const pointers = useRef(new Map<number, Point>());
  const dragged = useRef(false);

  const apply = useCallback((next: View) => {
    const width = viewport.current?.clientWidth ?? 0;
    const height = viewport.current?.clientHeight ?? 0;
    const limitX = Math.max(0, ((image.current?.clientWidth ?? 0) * next.scale - width) / 2);
    const limitY = Math.max(0, ((image.current?.clientHeight ?? 0) * next.scale - height) / 2);
    const bounded = {
      scale: next.scale,
      x: Math.max(-limitX, Math.min(limitX, next.x)),
      y: Math.max(-limitY, Math.min(limitY, next.y)),
    };
    viewRef.current = bounded;
    setView(bounded);
  }, []);

  const zoom = useCallback((scale: number, anchor?: Point, movement: Point = { x: 0, y: 0 }) => {
    const old = viewRef.current;
    const next = Math.max(1, Math.min(MAX_SCALE, scale));
    const bounds = viewport.current?.getBoundingClientRect();
    const x = anchor && bounds ? anchor.x - bounds.left - bounds.width / 2 : 0;
    const y = anchor && bounds ? anchor.y - bounds.top - bounds.height / 2 : 0;
    apply({
      scale: next,
      x: x - (x - old.x) * next / old.scale + movement.x,
      y: y - (y - old.y) * next / old.scale + movement.y,
    });
  }, [apply]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    // React wheel handlers are passive; cancel native scrolling only inside the image viewport.
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      if (!event.deltaY) return;
      zoom(viewRef.current.scale * (event.deltaY < 0 ? STEP : 1 / STEP), {
        x: event.clientX, y: event.clientY,
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    const resize = () => apply(viewRef.current);
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => {
      node.removeEventListener("wheel", wheel);
      observer.disconnect();
    };
  }, [apply, zoom]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") zoom(viewRef.current.scale * STEP);
      else if (event.key === "-") zoom(viewRef.current.scale / STEP);
      else if (event.key === "0") apply(FIT);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [apply, zoom]);

  const pointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    if (!pointers.current.size) dragged.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 2) dragged.current = true;
    if (pointers.current.size === 2) {
      const after = [...pointers.current.values()];
      const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const middle = (points: Point[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
      const from = middle(before);
      const to = middle(after);
      if (distance(before) > 0) zoom(viewRef.current.scale * distance(after) / distance(before), from, {
        x: to.x - from.x, y: to.y - from.y,
      });
    } else if (pointers.current.size === 1 && viewRef.current.scale > 1) {
      apply({ ...viewRef.current, x: viewRef.current.x + point.x - previous.x, y: viewRef.current.y + point.y - previous.y });
    }
  };

  const pointerEnd = (event: PointerEvent<HTMLImageElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={viewport}
      className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden"
      onClickCapture={(event) => {
        if (dragged.current && !(event.target as HTMLElement).closest("button")) {
          dragged.current = false;
          event.stopPropagation();
        }
      }}
    >
      <img
        ref={image}
        src={src}
        alt={alt}
        draggable={false}
        className={`max-w-full max-h-full shrink-0 object-contain select-none rounded-lg touch-none ${view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onLoad={() => apply(viewRef.current)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (viewRef.current.scale > 1) apply(FIT);
          else zoom(2, { x: event.clientX, y: event.clientY });
        }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
      />
      <div
        role="group"
        aria-label="Image zoom"
        className="absolute bottom-3 flex items-center gap-1 rounded-full bg-black/80 px-2 py-1 text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label="Zoom out" title="Zoom out (-)" disabled={view.scale <= 1}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/20 disabled:opacity-30"
          onClick={() => zoom(viewRef.current.scale / STEP)}>
          <ZoomOut className="h-5 w-5" />
        </button>
        <output className="min-w-12 text-center text-sm tabular-nums" aria-label="Zoom level">{Math.round(view.scale * 100)}%</output>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= MAX_SCALE}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/20 disabled:opacity-30"
          onClick={() => zoom(viewRef.current.scale * STEP)}>
          <ZoomIn className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Fit image" title="Fit image (0)"
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/20"
          onClick={() => apply(FIT)}>
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

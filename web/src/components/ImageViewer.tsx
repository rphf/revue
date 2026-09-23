import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface ViewerImage {
  label?: string;
  url: string;
  caption: string;
}

export interface ImageViewerProps {
  path: string;
  images: ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
const STEP = 1.25;

// Zoom is shown in screen pixels: at 100% one image pixel takes one
// device pixel, so a 2x screenshot on a 2x display reads as 100% at its
// sharpest, not 50%. The transform itself works in CSS pixels.
const devicePixels = () => window.devicePixelRatio || 1;

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// A full-window look at one image of a diff: it opens fitted, the wheel
// zooms around the pointer, a drag pans, a double-click toggles between
// fit and actual pixels. With both sides of a change, the switch keeps
// the view, so flipping between them compares the same spot.
export default function ImageViewer({
  path,
  images,
  index,
  onIndexChange,
  onClose,
}: ImageViewerProps) {
  // The stage mounts inside the dialog's portal, a render after this
  // component, so it is held as state for the wheel listener to follow.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const natural = useRef<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const image = images[index];

  const fitView = (): View | null => {
    const n = natural.current;
    if (!stage || !n) return null;
    const scale = Math.min(
      (stage.clientWidth - 32) / n.w,
      (stage.clientHeight - 32) / n.h,
      1,
    );
    return {
      scale,
      x: (stage.clientWidth - n.w * scale) / 2,
      y: (stage.clientHeight - n.h * scale) / 2,
    };
  };

  // Zooms to scale, keeping the image point under (cx, cy) in place;
  // without a point, the stage's center stays.
  const zoomTo = (scale: number, cx?: number, cy?: number) => {
    setView((v) => {
      if (!v || !stage) return v;
      const next = clamp(scale);
      const px = cx ?? stage.clientWidth / 2;
      const py = cy ?? stage.clientHeight / 2;
      const k = next / v.scale;
      return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  // React's wheel listener is passive, so the page would scroll too;
  // a native one can take the event.
  useEffect(() => {
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        if (!v) return v;
        const next = clamp(v.scale * Math.exp(-e.deltaY * 0.002));
        const k = next / v.scale;
        return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomTo((view?.scale ?? 1) * STEP);
    else if (e.key === "-") zoomTo((view?.scale ?? 1) / STEP);
    else if (e.key === "0") setView(fitView());
    else if (e.key === "1") zoomTo(1 / devicePixels());
    else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
    else if (e.key === "ArrowRight" && index < images.length - 1)
      onIndexChange(index + 1);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => v && { ...v, x: v.x + dx, y: v.y + dy });
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const fit = fitView();
    if (!view || !fit) return;
    if (Math.abs(view.scale - fit.scale) > 0.001) {
      setView(fit);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    zoomTo(1 / devicePixels(), e.clientX - rect.left, e.clientY - rect.top);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 flex h-dvh w-dvw max-w-none translate-none flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none"
        onKeyDown={onKeyDown}
        data-testid="image-viewer"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <div className="grid min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium">
              {path}
            </DialogTitle>
            <DialogDescription className="truncate text-xs tabular-nums">
              {image.caption}
            </DialogDescription>
          </div>
          {images.length > 1 && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={String(index)}
              onValueChange={(v) => v && onIndexChange(Number(v))}
              aria-label="Side"
            >
              {images.map((img, i) => (
                <ToggleGroupItem key={img.url} value={String(i)}>
                  {img.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => zoomTo((view?.scale ?? 1) / STEP)}
            >
              <MinusIcon />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-16 tabular-nums"
              aria-label="Fit to window"
              title="Fit to window (0)"
              onClick={() => setView(fitView())}
            >
              {view ? `${Math.round(view.scale * devicePixels() * 100)}%` : "–"}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => zoomTo((view?.scale ?? 1) * STEP)}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Actual pixels (1)"
              onClick={() => zoomTo(1 / devicePixels())}
            >
              1:1
            </Button>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        <div
          ref={setStage}
          className={cn(
            "image-checker relative min-h-0 flex-1 touch-none overflow-hidden select-none",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
        >
          <img
            src={image.url}
            alt={`${image.label ?? "Image"}: ${path}`}
            draggable={false}
            className="absolute top-0 left-0 max-w-none origin-top-left"
            style={
              view
                ? {
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    // Past two screen pixels per image pixel, single pixels
                    // stay sharp instead of blurring.
                    imageRendering:
                      view.scale * devicePixels() >= 2
                        ? "pixelated"
                        : undefined,
                  }
                : { visibility: "hidden" }
            }
            onLoad={(e) => {
              const prev = natural.current;
              const n = {
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              };
              natural.current = n;
              // The first image opens fitted. Switching sides keeps the
              // view, rescaled when the sides differ in size, so the same
              // part of the picture stays on screen.
              if (prev === null) setView(fitView());
              else if (prev.w !== n.w)
                setView((v) => v && { ...v, scale: (v.scale * prev.w) / n.w });
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

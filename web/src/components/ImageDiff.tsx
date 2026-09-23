import { useState } from "react";
import type { FileStatus } from "../types";
import type { DiffStyle } from "./DiffView";
import ImageViewer from "./ImageViewer";
import { formatBytes } from "@/lib/text";
import { cn } from "@/lib/utils";

export interface ImageDiffProps {
  path: string;
  status: FileStatus;
  oldUrl?: string;
  newUrl?: string;
  oldSize?: number;
  newSize?: number;
  diffStyle: DiffStyle;
}

interface SideInfo {
  label?: string;
  url: string;
  size?: number;
  tone?: "removed" | "added";
}

function caption(size?: number, dims?: string): string {
  return [size !== undefined ? formatBytes(size) : null, dims]
    .filter(Boolean)
    .join(" · ");
}

function Side({
  side,
  path,
  dims,
  onDims,
  onOpen,
}: {
  side: SideInfo;
  path: string;
  dims?: string;
  onDims: (dims: string) => void;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const { label, url, size, tone } = side;
  return (
    <figure className="grid min-w-0 gap-1.5">
      {label && (
        <figcaption
          className={cn(
            "text-xs font-medium",
            tone === "removed" && "text-removed",
            tone === "added" && "text-added",
          )}
        >
          {label}
        </figcaption>
      )}
      <button
        type="button"
        className={cn(
          "image-checker flex min-h-24 cursor-zoom-in items-center justify-center overflow-hidden rounded-md border p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          tone === "removed" && "border-removed/40",
          tone === "added" && "border-added/40",
        )}
        aria-label={`Open ${label ? label.toLowerCase() + " " : ""}image ${path}`}
        disabled={failed}
        onClick={onOpen}
      >
        {failed ? (
          <span className="text-xs text-muted-foreground">
            The image could not be loaded
          </span>
        ) : (
          <img
            src={url}
            alt={`${label ?? "Image"}: ${path}`}
            className="max-h-[480px] max-w-full object-contain"
            onLoad={(e) =>
              onDims(
                `${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`,
              )
            }
            onError={() => setFailed(true)}
          />
        )}
      </button>
      <p className="text-xs text-muted-foreground tabular-nums">
        {caption(size, dims)}
      </p>
    </figure>
  );
}

// An image file in the diff: the image on each side it has, old and new
// side by side in split view and stacked in unified view. A click opens
// the full-window viewer on that side.
export default function ImageDiff({
  path,
  status,
  oldUrl,
  newUrl,
  oldSize,
  newSize,
  diffStyle,
}: ImageDiffProps) {
  const both = oldUrl !== undefined && newUrl !== undefined;
  const sides: SideInfo[] = [];
  if (oldUrl !== undefined)
    sides.push({
      label: both ? "Before" : undefined,
      url: oldUrl,
      size: oldSize,
      tone: both || status === "deleted" ? "removed" : undefined,
    });
  if (newUrl !== undefined)
    sides.push({
      label: both ? "After" : undefined,
      url: newUrl,
      size: newSize,
      tone: both || status === "added" ? "added" : undefined,
    });
  const [dims, setDims] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div
      className={cn(
        "grid gap-4 px-4 py-3 font-sans",
        both && diffStyle === "split" && "grid-cols-2",
      )}
      data-testid={`image-diff-${path}`}
    >
      {sides.map((side, i) => (
        <Side
          key={side.url}
          side={side}
          path={path}
          dims={dims[side.url]}
          onDims={(d) => setDims((prev) => ({ ...prev, [side.url]: d }))}
          onOpen={() => setOpen(i)}
        />
      ))}
      {open !== null && (
        <ImageViewer
          path={path}
          images={sides.map((side) => ({
            label: side.label,
            url: side.url,
            caption: caption(side.size, dims[side.url]),
          }))}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

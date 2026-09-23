import { formatBytes } from "./text";

const IMAGE_EXTENSIONS = new Set([
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
]);

// The image types the server previews; anything else stays a plain
// binary card.
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// The header line for a binary file: its size, and for a change the
// size before and after with the difference.
export function binarySummary(oldSize?: number, newSize?: number): string {
  if (oldSize !== undefined && newSize !== undefined) {
    const delta = newSize - oldSize;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    return `${formatBytes(oldSize)} → ${formatBytes(newSize)} (${sign}${formatBytes(Math.abs(delta))})`;
  }
  const size = newSize ?? oldSize;
  return size !== undefined ? formatBytes(size) : "";
}

import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { FileVersions } from "../types";

// splitPatch slices a multi-file git patch into per-file sections,
// keyed by the new path, or the old one for a deleted file.
export function splitPatch(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    const newName = part.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const oldName = part.match(/^--- a\/(.+)$/m)?.[1];
    const name = newName ?? oldName;
    if (name) sections.set(name, part);
  }
  return sections;
}

// loadedFiles turns the server's two versions of a changed file into
// what the diff renderer needs to expand hunk context. Only changed
// and renamed files are loaded: added and deleted ones come whole.
export function loadedFiles(v: FileVersions): FileDiffLoadedFiles {
  if (v.newContent === null) {
    throw new Error(`${v.path}: no new version to expand context from`);
  }
  const newFile = { name: v.path, contents: v.newContent };
  if (v.oldContent === null) return { oldFile: null, newFile };
  return {
    oldFile: { name: v.oldPath || v.path, contents: v.oldContent },
    newFile,
  };
}

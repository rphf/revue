import { createContext } from "react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { AnnotationMeta } from "./DiffView";

// The diff's annotations per file, for the rendered documents: each one
// draws the threads on its lines itself. They come through a context,
// not through the document's item, so a new thread or comment form
// updates the document in place and the list keeps its layout and its
// scroll position.
export const RichNotesContext = createContext<
  ReadonlyMap<string, DiffLineAnnotation<AnnotationMeta>[]> | undefined
>(undefined);

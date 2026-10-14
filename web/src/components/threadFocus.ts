import { createContext } from "react";

// The thread a link just led to. Its card is outlined until the next
// click lands anywhere outside it.
export const FocusedThreadContext = createContext<number | null>(null);

// The comment a link led to inside that thread, outlined in its place
// of the card; null when the link was to the thread as a whole.
export const FocusedCommentContext = createContext<number | null>(null);

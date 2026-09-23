import { createContext } from "react";

// The thread a link just led to. Its card is outlined until the next
// click lands anywhere outside it.
export const FocusedThreadContext = createContext<number | null>(null);

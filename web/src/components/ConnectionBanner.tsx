import { WifiOffIcon } from "lucide-react";
import type { ConnectionState } from "../useEvents";

// Non-blocking reconnect notice (R7): appears on SSE drop, disappears
// on reconnect, never obscures or resets in-progress form input.
export default function ConnectionBanner({
  state,
}: {
  state: ConnectionState;
}) {
  if (state !== "reconnecting") return null;
  return (
    <div
      role="status"
      className="fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-md"
    >
      <WifiOffIcon className="size-3.5 text-renamed" />
      Connection lost — reconnecting…
    </div>
  );
}

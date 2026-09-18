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
    <div className="connection-banner" role="status">
      Connection lost — reconnecting…
    </div>
  );
}

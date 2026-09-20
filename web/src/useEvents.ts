import { useEffect, useEffectEvent, useState } from "react";
import { argsQuery } from "./api";
import type { RevueEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "reconnecting";

// Subscribes to the event stream for one diff: persisted thread events
// plus diff.changed notices for these arguments. EventSource reconnects
// on its own; we surface the state so the UI can show a non-blocking
// banner that never touches unsent form text.
export function useEvents(
  args: string[],
  onEvent: (e: RevueEvent) => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const handle = useEffectEvent(onEvent);
  const query = argsQuery(args);

  useEffect(() => {
    const es = new EventSource(`/api/events${query}`);
    es.onopen = () => setState("open");
    es.onerror = () => setState("reconnecting");
    es.onmessage = (m) => {
      try {
        handle(JSON.parse(m.data));
      } catch {
        // Malformed frame; the next query will resync.
      }
    };
    return () => es.close();
  }, [query]);

  return state;
}

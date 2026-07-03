import { useEffect, useRef, useState } from "react";
import type { RevueEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "reconnecting";

// Subscribes to a review's SSE stream. EventSource reconnects on its
// own; we surface the state so the UI can show a non-blocking banner
// that never touches unsent form text.
export function useEvents(
  reviewId: number | null,
  onEvent: (e: RevueEvent) => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (reviewId === null) return;
    const es = new EventSource(`/api/reviews/${reviewId}/events`);
    es.onopen = () => setState("open");
    es.onerror = () => setState("reconnecting");
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data));
      } catch {
        // Malformed frame; the next query will resync.
      }
    };
    return () => es.close();
  }, [reviewId]);

  return state;
}

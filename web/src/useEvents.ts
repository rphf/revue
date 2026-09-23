import { useEffect, useEffectEvent, useRef, useState } from "react";
import { argsQuery } from "./lib/diffArgs";
import type { RevueEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "reconnecting";

// Subscribes to the event stream for one diff: persisted thread events
// plus diff.changed notices for these arguments. EventSource reconnects
// on its own and resumes through Last-Event-ID; a stream opened for new
// arguments resumes from the last event seen here with `since`, so it
// does not replay the whole log. We surface the state so the UI can
// show a non-blocking banner that never touches unsent form text.
export function useEvents(
  args: string[],
  onEvent: (e: RevueEvent) => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const handle = useEffectEvent(onEvent);
  const lastId = useRef<number | null>(null);
  const key = argsQuery(args);
  const url = useEffectEvent(() => {
    const since = lastId.current;
    return `/api/events${argsQuery(args, since !== null ? { since: String(since) } : undefined)}`;
  });

  useEffect(() => {
    const es = new EventSource(url());
    es.onopen = () => setState("open");
    es.onerror = () => setState("reconnecting");
    es.onmessage = (m) => {
      let event: RevueEvent;
      try {
        event = JSON.parse(m.data);
      } catch {
        // Malformed frame; the next query will resync.
        return;
      }
      if (typeof event.id === "number") lastId.current = event.id;
      handle(event);
    };
    return () => es.close();
  }, [key]);

  return state;
}

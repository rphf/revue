// coalesce wraps a load so one runs at a time, and any number of calls
// while it is in flight make one more after it: a burst of events costs
// at most two fetches.
export function coalesce(load: () => Promise<unknown>): () => void {
  let inFlight = false;
  let again = false;
  const run = () => {
    inFlight = true;
    again = false;
    load()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again) run();
      });
  };
  return () => {
    if (inFlight) again = true;
    else run();
  };
}

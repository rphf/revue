import { useCallback, useSyncExternalStore } from "react";

// Folds the reviewer chose by hand, kept in this browser: thread id to
// folded or open. A thread without a choice follows its default.
const THREADS_KEY = "revue-folded-threads";

type Choices = Readonly<Record<string, boolean>>;

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: Choices } | null = null;

function read(): Choices {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(THREADS_KEY);
  } catch {
    // Storage may be off; every thread then follows its default.
  }
  if (cache?.raw === raw) return cache.value;
  let value: Choices = {};
  try {
    const obj: unknown = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === "object")
      value = Object.fromEntries(
        Object.entries(obj).filter(
          (e): e is [string, boolean] => typeof e[1] === "boolean",
        ),
      );
  } catch {
    // A choice that cannot be read is a default.
  }
  cache = { raw, value };
  return value;
}

function write(id: number, folded: boolean) {
  try {
    localStorage.setItem(
      THREADS_KEY,
      JSON.stringify({ ...read(), [id]: folded }),
    );
  } catch {
    // Not remembering the fold only loses it on reload.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// useThreadFold returns whether a thread is folded, by the reviewer's
// choice or else the default, and the setter that records a choice.
export function useThreadFold(
  id: number,
  byDefault: boolean,
): [boolean, (folded: boolean) => void] {
  const choice = useSyncExternalStore(subscribe, () => read()[id]);
  const set = useCallback((folded: boolean) => write(id, folded), [id]);
  return [choice ?? byDefault, set];
}

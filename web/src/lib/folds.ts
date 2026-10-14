import { useCallback, useSyncExternalStore } from "react";

type Choices = Readonly<Record<string, boolean>>;

// A map of id to choice kept in this browser, read through
// useSyncExternalStore so every card shows the same choice.
function choiceStore(key: string) {
  const listeners = new Set<() => void>();
  let cache: { raw: string | null; value: Choices } | null = null;

  const read = (): Choices => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      // Storage may be off; every id then follows its default.
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
  };

  const write = (id: number, on: boolean) => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...read(), [id]: on }));
    } catch {
      // Not remembering the choice only loses it on reload.
    }
    for (const fn of listeners) fn();
  };

  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  // The choice for one id, or else the default, and its setter.
  return function useChoice(
    id: number,
    byDefault: boolean,
  ): [boolean, (on: boolean) => void] {
    const choice = useSyncExternalStore(subscribe, () => read()[id]);
    const set = useCallback((on: boolean) => write(id, on), [id]);
    return [choice ?? byDefault, set];
  };
}

// Whether a thread is folded, by the reviewer's choice or else the
// default, and the setter that records a choice.
export const useThreadFold = choiceStore("revue-folded-threads");

// Whether the reviewer minimized a comment; none is by default.
const useMinimized = choiceStore("revue-minimized-comments");
export const useCommentMinimized = (id: number) => useMinimized(id, false);

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

const PREFIX = "revue-scroll:";
const RESTORE_WAIT_MS = 2000;

function readScroll(key: string): number | null {
  try {
    const v = sessionStorage.getItem(PREFIX + key);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function writeScroll(key: string, top: number): void {
  try {
    sessionStorage.setItem(PREFIX + key, String(Math.round(top)));
  } catch {
    // Not remembering the position only loses it on reload.
  }
}

// Keeps a diff's scroll position across reloads of the tab: saved per
// diff in session storage as the reviewer scrolls, restored once when
// the diff first renders. Returns the CodeView onScroll handler.
export function useScrollMemory<A, C>(
  ref: RefObject<CodeViewHandle<A, C> | null>,
  key: string | undefined,
  ready: boolean,
): (scrollTop: number) => void {
  const restored = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!key || !ready || restored.current === key) return;
    const top = readScroll(key);
    if (top === null || top <= 0) {
      restored.current = key;
      return;
    }
    // The container's own scrollTop, not a CodeView position target:
    // that one takes the sticky header's height off. Firefox lays the
    // items out a few frames after the first render, and a scroll past
    // the height it has then is clamped, so wait until the position
    // fits, or give up after a while and go as far as it goes.
    const deadline = performance.now() + RESTORE_WAIT_MS;
    let frame = 0;
    const attempt = () => {
      const el = ref.current?.getInstance()?.getContainerElement();
      const fits = el && el.scrollHeight - el.clientHeight >= top;
      if (el && (fits || performance.now() > deadline)) {
        el.scrollTo({ top });
        restored.current = key;
        return;
      }
      frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [ref, key, ready]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return useCallback(
    (scrollTop: number) => {
      if (!key || restored.current !== key) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => writeScroll(key, scrollTop), 150);
    },
    [key],
  );
}

import { useEffect, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

const FIREFOX =
  typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);

// Firefox leaves a file's sticky header where it was when the files
// around it resize without a scroll (a placeholder rendering at its
// full height), mid-file, until the next scroll event. A ResizeObserver
// runs before paint, so laying the headers out again from it puts them
// back in the same frame.
export function useStickyHeaderFix<A, C>(
  ref: RefObject<CodeViewHandle<A, C> | null>,
): void {
  useEffect(() => {
    if (!FIREFOX) return;
    let frame = 0;
    let detach: (() => void) | undefined;
    const attach = () => {
      const root = ref.current?.getInstance()?.getContainerElement();
      if (!root) {
        frame = requestAnimationFrame(attach);
        return;
      }
      const hosts = () => root.querySelectorAll("diffs-container");
      const relayout = () => {
        for (const host of hosts()) {
          const header = host.shadowRoot?.querySelector<HTMLElement>(
            "[data-diffs-header]",
          );
          if (!header) continue;
          header.style.position = "relative";
          header.getBoundingClientRect();
          header.style.position = "";
        }
      };
      const resize = new ResizeObserver(relayout);
      const observed = new Set<Element>();
      const track = () => {
        for (const host of observed) {
          if (host.isConnected) continue;
          resize.unobserve(host);
          observed.delete(host);
        }
        for (const host of hosts()) {
          if (observed.has(host)) continue;
          resize.observe(host);
          observed.add(host);
        }
      };
      const mutations = new MutationObserver(track);
      mutations.observe(root, { childList: true, subtree: true });
      track();
      detach = () => {
        mutations.disconnect();
        resize.disconnect();
      };
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      detach?.();
    };
  }, [ref]);
}

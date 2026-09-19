import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no ResizeObserver; the resizable panes construct one on
// mount. Layout math is not under test, so an inert stand-in will do.
if (typeof globalThis.ResizeObserver === "undefined") {
  class InertResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    InertResizeObserver as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

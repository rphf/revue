import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import App from "./App";
import { THEMES } from "./components/codeViewStyle";
import "./index.css";

// Syntax highlighting runs in a pool of workers, not on the main thread,
// so files scrolled into view tokenize without dropping frames. One core
// stays free for the page itself.
const poolSize = Math.max(
  1,
  Math.min(4, (navigator.hardwareConcurrency || 4) - 1),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize }}
      highlighterOptions={{ theme: THEMES }}
    >
      <App />
    </WorkerPoolContextProvider>
  </StrictMode>,
);

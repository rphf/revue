import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser-level proof of the review loop against the real binary:
// single chromium project, one worker (specs share one seeded server),
// external hosts blocked at the DNS level.

export const E2E_PORT = 4917;
export const E2E_TOKEN = "e2e-fixed-token-2f7c9a4d8b1e6035";
const E2E_DIR = path.join(import.meta.dirname, ".e2e");
// The browser reaches the server via localhost: the DNS-block flag
// below maps every other name (and IP literals) to NOTFOUND.
const BASE = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/helpers/global-setup.ts",
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    launchOptions: {
      // localhost only: any other hostname fails DNS resolution.
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"],
    },
  },
  projects: [
    {
      name: "chromium",
      // A review surface: split view plus thread cards need more height
      // than the 1280x720 device default before rows leave the viewport.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "bash tests/scripts/start-test-server.sh",
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      REVUE_E2E_DIR: E2E_DIR,
      REVUE_E2E_PORT: String(E2E_PORT),
      REVUE_E2E_TOKEN: E2E_TOKEN,
    },
  },
});

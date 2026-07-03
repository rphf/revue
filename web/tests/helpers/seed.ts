import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../../playwright.config";

export const BASE = `http://localhost:${E2E_PORT}`;
export const TOKEN = E2E_TOKEN;

const E2E_DIR = path.join(import.meta.dirname, "..", "..", ".e2e");
export const REPO = path.join(E2E_DIR, "repo");
const BIN = path.join(import.meta.dirname, "..", "..", "..", "bin", "revue");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// cli runs the real revue binary as a child process, exactly like an
// agent would, against the shared test server.
export function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      BIN,
      args,
      {
        cwd: REPO,
        env: {
          ...process.env,
          REVUE_DATA_DIR: path.join(E2E_DIR, "data"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function cliJSON<T>(res: CliResult): T {
  return JSON.parse(res.stdout) as T;
}

// api calls the server the way the CLI does (header token).
export async function api<T>(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(BASE + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(
      `${method} ${apiPath}: ${resp.status} ${await resp.text()}`,
    );
  }
  return (await resp.json()) as T;
}

// authenticate performs the one-time token-for-cookie exchange, then
// lands on a token-free URL (R23).
export async function authenticate(page: Page, next = "/"): Promise<void> {
  await page.goto(
    `${BASE}/auth?token=${TOKEN}&next=${encodeURIComponent(next)}`,
  );
}

export function writeFixtureFile(name: string, content: string): void {
  fs.writeFileSync(path.join(REPO, name), content);
}

// draftComment creates a reviewer draft through the real gutter UI on
// the diff line containing lineText. Hovering the line registers it
// with the diff's interaction manager; the gutter "+" is CSS-hover
// gated, so the click is dispatched directly — the manager resolves
// the line from its own hover state, not the pointer.
export async function draftComment(
  page: Page,
  filePath: string,
  lineText: string,
  body: string,
): Promise<void> {
  await page.getByText(lineText).first().hover();
  const gutterAdd = page.locator(`.gutter-add[data-path="${filePath}"]`);
  await gutterAdd.dispatchEvent("click");
  const box = page.getByPlaceholder(/Comment on line/);
  await expect(box).toBeVisible();
  await box.fill(body);
  // Annotation controls live inside CodeView's virtualized layout,
  // where Playwright's scroll-into-view can't stabilize elements
  // below the fold; dispatch the click directly.
  await page.getByRole("button", { name: "Start thread" }).dispatchEvent("click");
  await expect(page.getByText(body)).toBeVisible();
}

export function readFixtureFile(name: string): string {
  return fs.readFileSync(path.join(REPO, name), "utf8");
}

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

// git runs git in the fixture repository, as the agent would.
export function git(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: REPO,
        env: {
          ...process.env,
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
// the diff line containing lineText: hover the line, click the diff's
// own "+" (inside the shadow root, which locators pierce), fill the
// form, start the thread, and wait until the server has it. CodeView virtualizes rows and re-renders
// them as highlighting streams in, so any step can find its node gone;
// each block retries as a whole until it passes.
export async function draftComment(
  page: Page,
  lineText: string,
  body: string,
): Promise<void> {
  const line = page.getByText(lineText).first();
  await expect(async () => {
    await line.scrollIntoViewIfNeeded();
    await line.hover();
    const plus = page.locator("[data-utility-button]").first();
    const lineBox = await line.boundingBox();
    const plusBox = await plus.boundingBox();
    expect(lineBox).not.toBeNull();
    expect(plusBox).not.toBeNull();
    const lineMid = lineBox!.y + lineBox!.height / 2;
    expect(Math.abs(plusBox!.y + plusBox!.height / 2 - lineMid)).toBeLessThan(
      lineBox!.height,
    );
    await page.mouse.move(
      plusBox!.x + plusBox!.width / 2,
      plusBox!.y + plusBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByPlaceholder(/Comment on line/)).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await page.getByPlaceholder(/Comment on line/).fill(body);
  // Annotation controls live inside CodeView's virtualized layout,
  // where Playwright's scroll-into-view can't stabilize elements
  // below the fold; dispatch the click directly.
  await page
    .getByRole("button", { name: "Start thread" })
    .dispatchEvent("click");
  // The form's own textarea holds the body too, so the text alone
  // shows up before the server has the draft. The form closes once
  // the thread is saved, and the body is then in a thread card.
  await expect(page.getByPlaceholder(/Comment on line/)).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(async () => {
    await line.scrollIntoViewIfNeeded();
    await expect(page.locator("[data-thread-id]").getByText(body)).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
}

export function readFixtureFile(name: string): string {
  return fs.readFileSync(path.join(REPO, name), "utf8");
}

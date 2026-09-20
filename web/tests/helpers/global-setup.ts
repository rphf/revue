import { E2E_PORT, E2E_TOKEN } from "../../playwright.config";

// The webServer block only waits for the port to accept connections;
// wait here until the server is healthy AND serves the fixture diff,
// so the first spec never races the fixture setup.
export default async function globalSetup(): Promise<void> {
  const base = `http://127.0.0.1:${E2E_PORT}`;
  const headers = { Authorization: `Bearer ${E2E_TOKEN}` };
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${base}/healthz`, { headers });
      if (health.ok) {
        const diff = await fetch(`${base}/api/diff`, { headers });
        if (diff.ok) {
          const body = (await diff.json()) as { files: unknown[] };
          if (body.files.length >= 2) return;
        }
      }
    } catch {
      // Server not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("e2e server did not become ready with the fixture diff");
}

/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  build: {
    outDir: "../internal/server/ui/dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Playwright specs live under tests/ and are not vitest's.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

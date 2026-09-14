import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Historical prototype cases assert localStorage and fake-payment buttons.
  // The current suite below replaces those expectations with server-backed behavior.
  testMatch: "**/business.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5188",
    viewport: { width: 1440, height: 1000 },
    browserName: "chromium",
    launchOptions: {
      executablePath:
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    },
    headless: true,
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "node scripts/e2e-server.mjs", url: "http://127.0.0.1:5189/api/health", reuseExistingServer: false },
    { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5188 --strictPort", url: "http://127.0.0.1:5188", env: { CLUB_API_TARGET: "http://127.0.0.1:5189" }, reuseExistingServer: false },
  ],
});

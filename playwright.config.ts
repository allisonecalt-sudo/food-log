import { defineConfig, devices } from '@playwright/test';

// food-log Playwright config — v1.6.
//
// Port 4321 (not 3000): on this Windows dev box something else holds port 3000
// (responds to HTTP but not our content) and the old `tcp://127.0.0.1:3000`
// workaround now collides with that. 4321 is conventionally free.
//
// `serve` from npm gets the `-l` argument parsed differently under Git-Bash on
// Windows (bare `-l 4321` is interpreted as a path token via MSYS path
// translation, falling back to a random port). Explicit `tcp://` URI form
// pins it correctly on every shell.
//
// webServer timeout bumped to 120s — first-time `tsc` build + npm install on
// CI cold-start can take longer than 60s on Windows runners.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx serve -l tcp://0.0.0.0:4321 .',
    url: 'http://127.0.0.1:4321/manifest.webmanifest',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

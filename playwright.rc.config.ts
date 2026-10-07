import { defineConfig, devices } from '@playwright/test';

/**
 * REPAIR-CORE-07 — RELEASE-CANDIDATE QUALIFICATION.
 *
 * Serves the PACKAGED ARTIFACT (`artifacts/release/site`, exactly the bytes a host would receive)
 * under the DEPLOYMENT header template (CSP, Permissions-Policy, COOP/COEP/CORP), and runs the
 * product through its public UI. Serial: memory and timing evidence is only meaningful when
 * nothing else competes for the machine. Needs `npm run build && npm run release:build` first.
 */
const PORT = 4190;

export default defineConfig({
  testDir: './e2e-rc',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: 'list',
  use: { baseURL: `http://localhost:${String(PORT)}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/release-server.mjs --port ${String(PORT)} --root artifacts/release/site --deployment-headers`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

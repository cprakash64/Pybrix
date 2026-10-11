import { defineConfig, devices } from '@playwright/test';
import { APP_BASE_URL } from './e2e/app-origin';

/**
 * AUTO SPLIT, END TO END: the shipped application, the real geometry worker, the real same-origin
 * service (its production request handling, validation, limits and logging) and a DETERMINISTIC
 * PROVIDER in place of OpenAI.
 *
 * SEPARATE FROM THE APPLICATION SUITE because it needs a second process, and SERIAL because the test
 * server's provider is steered by one global control (which scenario it answers, how it misbehaves). A
 * client address is faked per test through `X-Real-IP` (the service trusts it here, as it trusts the
 * proxy in production), so each test has its own rate-limit bucket.
 *
 * NO OPENAI KEY IS READ OR NEEDED. Nothing here reaches the network beyond localhost.
 */
const SERVICE_PORT = '8787';

export default defineConfig({
  testDir: './e2e-auto-split',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  timeout: 240_000,
  use: { baseURL: APP_BASE_URL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: APP_BASE_URL,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 240_000,
      env: { AUTO_SPLIT_PORT: SERVICE_PORT },
    },
    {
      command:
        'npm run build:test-server --workspace @cadfixer/auto-split-api && npm run start:test-server --workspace @cadfixer/auto-split-api',
      url: `http://127.0.0.1:${SERVICE_PORT}/api/auto-split/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AUTO_SPLIT_PORT: SERVICE_PORT,
        AUTO_SPLIT_HOST: '127.0.0.1',
        AUTO_SPLIT_TRUST_PROXY: '1',
        AUTO_SPLIT_RATE_MAX: '3',
        // The service-wide ceilings are proven in the service tests with a counting provider; here they are
        // set out of the way so a long suite (or a screenshot run) cannot meet them by accident.
        AUTO_SPLIT_GLOBAL_RATE_MAX: '100000',
        AUTO_SPLIT_GLOBAL_DAILY_MAX: '100000',
        AUTO_SPLIT_PROVIDER_RETRIES: '0',
        AUTO_SPLIT_RETRY_DELAY_MS: '0',
      },
    },
  ],
});

/**
 * Example: drive demogen programmatically (instead of via the CLI).
 *
 * This pattern is useful when you need to:
 *   - bring up a dev stack before recording
 *   - bootstrap auth via a custom flow (WorkOS, Clerk, magic link, ...)
 *   - chain multiple recordings together
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { runDemoPipeline, type SetupAuthFn } from "demogen";

// Example: bootstrap auth by calling an `/api/test-session` route on your
// dev server that sets a session cookie. The route does whatever your app
// needs to log a user in (read seeded credentials, mint a token, etc.) and
// then redirects to "/". demogen captures the resulting cookie via
// storageState and feeds it into the recording browser context.
const setupAuth: SetupAuthFn = async ({ role, baseURL, headless }) => {
  const storageStatePath = join(tmpdir(), `demogen-auth-${role}.json`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto(`/api/test-session?role=${role}`);
    await page.waitForURL("/");
    await context.storageState({ path: storageStatePath });
  } finally {
    await context.close();
    await browser.close();
  }
  return storageStatePath;
};

await runDemoPipeline("./scripts/my-demo.demo.yaml", {
  baseURL: "http://localhost:3000",
  headless: true,
  setupAuth,
});

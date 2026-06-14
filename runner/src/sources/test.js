// Test source — reuses the existing Playwright test-runner poll loop.
import { pollTest as _pollTest } from "../../../test-runner/src/index.js";
export async function pollTest() {
  return _pollTest();
}

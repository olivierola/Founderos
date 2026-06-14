// Ops source — reuses the existing ops-runner poll loop (SSH / infra jobs).
import { pollOps as _pollOps } from "../../../ops-runner/src/index.js";
export async function pollOps() {
  return _pollOps();
}

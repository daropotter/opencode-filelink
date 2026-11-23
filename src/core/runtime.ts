import { createRecordingSpawner, type ExecOptions } from "./exec.js"
import type { Logger } from "./log.js"

/**
 * Executor options from the environment. `OPENCODE_FILELINK_DRY_RUN=1` swaps
 * the real spawner for one that only logs the commands (smoke tests, debugging).
 */
export function execOptionsFromEnv(env: Readonly<Record<string, string | undefined>>, log: Logger): ExecOptions {
  if (env.OPENCODE_FILELINK_DRY_RUN === "1" || env.OPENCODE_FILELINK_DRY_RUN === "true") {
    return { spawner: createRecordingSpawner((cmd, args) => log(`dry-run: ${JSON.stringify([cmd, ...args])}`)) }
  }
  return {}
}

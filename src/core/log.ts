import { appendFileSync } from "node:fs"

export type Logger = (msg: string) => void

/**
 * Logger. Writes to the file named by `OPENCODE_FILELINK_LOG` when set and is
 * silent otherwise. Writing to stderr is opt-in (`stderr: true`) and neither
 * part enables it: in the TUI process it would corrupt the terminal UI, and
 * the server may share that terminal (`--standalone`).
 */
export function createLogger(
  scope: "server" | "tui",
  opts: { stderr?: boolean; env?: Readonly<Record<string, string | undefined>> } = {},
): Logger {
  const env = opts.env ?? process.env
  const file = env.OPENCODE_FILELINK_LOG
  return (msg: string) => {
    const line = `[opencode-filelink:${scope}] ${msg}`
    if (file) {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // ignore
      }
    }
    if (opts.stderr) {
      try {
        console.error(line)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Windows executable resolution for editor commands.
 *
 * Two hazards make a bare command name unsafe to hand to `spawn` on Windows:
 *
 * 1. CreateProcess (and libuv's search) looks in the current directory before
 *    PATH. A project containing `code.exe` or `explorer.exe` would be run
 *    instead of the real program. So commands are resolved to absolute paths
 *    here, searching only absolute PATH entries.
 * 2. Batch files (`.cmd`/`.bat`, e.g. VS Code's `code.cmd` shim) always run
 *    through `cmd.exe`, which re-parses the command line: `&`, `|`, `%`, `^`
 *    and `!` in a file name would become shell syntax (BatBadBut). Node >= 20.12
 *    refuses to spawn them without `shell: true`. There is no escaping scheme
 *    that is provably safe for every `%*`-forwarding shim, so batch files are
 *    never executed. Known Electron editor shims (`bin\code.cmd` next to
 *    `Code.exe`) are mapped to the real executable, the same way the shim
 *    itself starts it. Anything else is refused with a clear message.
 */
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"

export interface WinResolveDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  /** True when `p` is an existing regular file. */
  readonly isFile?: (p: string) => boolean
}

export type WinResolved =
  | {
      readonly ok: true
      readonly cmd: string
      /** Arguments inserted before the template's arguments (Electron `cli.js`). */
      readonly prefixArgs: readonly string[]
      /** Extra environment for the child (Electron `ELECTRON_RUN_AS_NODE`). */
      readonly env?: Readonly<Record<string, string>>
    }
  | { readonly ok: false; readonly reason: string }

const w = nodePath.win32

/** `.cmd` / `.bat`, tolerating the trailing dots and spaces Windows strips from names. */
export function isBatchFile(p: string): boolean {
  return /\.(cmd|bat)[. ]*$/i.test(p)
}

/** Electron editors whose `bin\<name>.cmd` shim starts `..\<Exe>` with `..\resources\app\out\cli.js`. */
const ELECTRON_SHIMS: Readonly<Record<string, readonly string[]>> = {
  code: ["Code.exe"],
  "code-insiders": ["Code - Insiders.exe"],
  codium: ["VSCodium.exe"],
  "codium-insiders": ["VSCodium - Insiders.exe"],
  cursor: ["Cursor.exe"],
  windsurf: ["Windsurf.exe"],
}

function defaultIsFile(p: string): boolean {
  try {
    return nodeFs.statSync(p).isFile()
  } catch {
    return false
  }
}

function envGet(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v
  return undefined
}

/** `%SystemRoot%\explorer.exe` as an absolute path (never looked up in the current directory). */
export function explorerPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = envGet(env, "SystemRoot") || envGet(env, "windir") || "C:\\Windows"
  return w.join(w.isAbsolute(root) ? root : "C:\\Windows", "explorer.exe")
}

function mapShim(shim: string, isFile: (p: string) => boolean): WinResolved | undefined {
  const dir = w.dirname(shim)
  if (w.basename(dir).toLowerCase() !== "bin") return undefined
  const root = w.dirname(dir)
  const base = w
    .basename(shim)
    .replace(/\.(cmd|bat)[. ]*$/i, "")
    .toLowerCase()
  const names = ELECTRON_SHIMS[base]
  if (!names) return undefined
  for (const name of names) {
    const exe = w.join(root, name)
    if (!isFile(exe)) continue
    const cli = w.join(root, "resources", "app", "out", "cli.js")
    // Mirror the shim exactly when its layout is recognised; otherwise the
    // Electron main process parses `-g file:line` itself.
    if (isFile(cli)) return { ok: true, cmd: exe, prefixArgs: [cli], env: { ELECTRON_RUN_AS_NODE: "1" } }
    return { ok: true, cmd: exe, prefixArgs: [] }
  }
  return undefined
}

function refuseBatch(cmd: string, found: string): WinResolved {
  return {
    ok: false,
    reason: `"${cmd}" is a batch file (${found}); batch files cannot be started safely without a shell. Set "editor" to the editor's .exe, for example ["C:\\\\path\\\\to\\\\Editor.exe", "{file}"]`,
  }
}

/**
 * Resolve an editor command to an absolute, non-batch executable.
 * Bare names are searched in absolute PATH entries only (with PATHEXT
 * restricted to .com/.exe/.cmd/.bat); the current directory is never searched.
 */
export function resolveWindowsCommand(cmd: string, deps: WinResolveDeps): WinResolved {
  const isFile = deps.isFile ?? defaultIsFile
  const hasExt = /\.[^.\\/]+$/.test(cmd)
  const extsFromEnv = (envGet(deps.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e === ".com" || e === ".exe" || e === ".bat" || e === ".cmd")
  const exts = hasExt ? [""] : extsFromEnv.length > 0 ? extsFromEnv : [".com", ".exe", ".bat", ".cmd"]

  let candidates: string[]
  if (/[\\/]/.test(cmd)) {
    if (!w.isAbsolute(cmd) || /^[\\/](?![\\/])/.test(cmd)) {
      return { ok: false, reason: `editor command "${cmd}" must be a bare name or an absolute path` }
    }
    candidates = exts.map((e) => cmd + e)
  } else {
    const dirs = (envGet(deps.env, "PATH") ?? "")
      .split(";")
      .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
      .filter((d) => d !== "" && w.isAbsolute(d) && !/^[\\/](?![\\/])/.test(d))
    candidates = []
    for (const d of dirs) for (const e of exts) candidates.push(w.join(d, cmd + e))
  }

  for (const c of candidates) {
    if (!isFile(c)) continue
    if (isBatchFile(c)) return mapShim(c, isFile) ?? refuseBatch(cmd, c)
    return { ok: true, cmd: c, prefixArgs: [] }
  }
  return { ok: false, reason: `"${cmd}" was not found on PATH` }
}

/**
 * Make a command chain safe to spawn on Windows: `explorer.exe` becomes
 * `%SystemRoot%\explorer.exe`, everything else goes through
 * `resolveWindowsCommand`. Commands that cannot be resolved are dropped; the
 * reasons are returned so the caller can explain a fallback.
 */
export function resolveWindowsCommands<
  C extends { readonly cmd: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> },
>(commands: readonly C[], deps: WinResolveDeps): { commands: C[]; errors: string[] } {
  const out: C[] = []
  const errors: string[] = []
  for (const c of commands) {
    if (c.cmd.toLowerCase() === "explorer.exe") {
      out.push({ ...c, cmd: explorerPath(deps.env) })
      continue
    }
    const r = resolveWindowsCommand(c.cmd, deps)
    if (!r.ok) {
      errors.push(r.reason)
      continue
    }
    out.push({ ...c, cmd: r.cmd, args: [...r.prefixArgs, ...c.args], ...(r.env ? { env: { ...c.env, ...r.env } } : {}) })
  }
  return { commands: out, errors }
}

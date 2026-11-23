import type { FilelinkConfig } from "../config.js"
import type { Action } from "../types.js"
import { buildCommands, type Command, wslToWindowsPath } from "./commands.js"
import { type Attempt, wslpath as defaultWslpath, type ExecOptions, runCommands } from "./exec.js"
import type { Platform } from "./platform.js"
import { type ResolvedTarget, type ResolverFs, resolveTarget } from "./resolve.js"
import { resolveWindowsCommands, type WinResolveDeps } from "./winexe.js"

export interface OpenRequest {
  /** Link href or a path (relative to `baseDir`, absolute, `~/`, `file://`). */
  readonly href: string
  /** Explicit action (tool argument, dialog action). Overrides the configured choice. */
  readonly action?: Action
  /** Explicit line (agent tool). Overrides a line parsed from the href. */
  readonly line?: number
  readonly col?: number
}

export interface OpenerDeps {
  readonly config: FilelinkConfig
  readonly baseDir: string
  /** Additional allowed roots besides baseDir and config.extraRoots (e.g. the project dir). */
  readonly roots?: readonly string[]
  readonly platform: Platform
  readonly exec?: ExecOptions
  readonly wslpath?: (posixPath: string) => Promise<string | undefined>
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fs?: ResolverFs
  readonly homeDir?: string
  /** Windows only: file test used to resolve editor executables (tests). */
  readonly isFile?: WinResolveDeps["isFile"]
}

export interface OpenOutcome {
  readonly ok: boolean
  readonly message: string
  /** Set when the request was carried out differently than asked (shown as a warning). */
  readonly warning?: string
  readonly action?: Action
  readonly target?: ResolvedTarget
  readonly attempts?: readonly Attempt[]
}

/** Decide the action: explicit > line-link rule > configured action; "editor" needs an editor. */
export function chooseAction(config: FilelinkConfig, hasLine: boolean, override?: Action): { action: Action; fellBack: boolean } {
  let desired: Action
  if (override) desired = override
  else if (hasLine) desired = config.lineAction ?? (config.editor ? "editor" : config.action)
  else desired = config.action
  if (desired === "editor" && !config.editor) {
    return { action: config.action !== "editor" ? config.action : "open", fellBack: true }
  }
  return { action: desired, fellBack: false }
}

/** Extensions whose "open with the default application" runs code instead of showing a document. */
const EXECUTABLE_EXT: Readonly<Record<"windows" | "darwin" | "linux", ReadonlySet<string>>> = {
  windows: new Set(
    "exe com bat cmd ps1 psm1 vbs vbe js jse wsf wsh msi msp scr lnk url pif hta cpl msc jar reg application appref-ms gadget inf scf settingcontent-ms library-ms search-ms appx msix msixbundle appinstaller diagcab".split(
      " ",
    ),
  ),
  darwin: new Set("app command tool terminal workflow action pkg mpkg jar fileloc inetloc webloc scpt scptd osax prefpane".split(" ")),
  linux: new Set("desktop appimage jar run".split(" ")),
}

/**
 * True when opening `path` with the default application would likely execute
 * it (scripts, installers, shortcuts, app bundles). Such targets are revealed
 * instead, so one click on a link written by the model cannot run code.
 */
export function isExecutableLike(path: string, platform: Platform): boolean {
  const base = path.replace(/[/]+$/, "").split(/[/]/).pop() ?? ""
  const m = /\.([^.]+)[. ]*$/.exec(base)
  if (!m?.[1]) return false
  const ext = m[1].toLowerCase()
  const family = platform === "win32" || platform === "wsl" ? "windows" : platform === "darwin" ? "darwin" : "linux"
  return EXECUTABLE_EXT[family].has(ext)
}

function describe(action: Action, target: ResolvedTarget): string {
  const where =
    target.line !== undefined ? `${target.display}:${target.line}${target.col !== undefined ? `:${target.col}` : ""}` : target.display
  if (action === "reveal") return `Revealed ${where} in the file manager`
  if (action === "editor") return `Opened ${where} in the editor`
  return `Opened ${where}`
}

/** Resolve, apply policy, pick commands and launch. Never throws. */
export async function openLink(req: OpenRequest, deps: OpenerDeps): Promise<OpenOutcome> {
  try {
    const resolved = resolveTarget(req.href, {
      baseDir: deps.baseDir,
      roots: [...(deps.roots ?? []), ...deps.config.extraRoots],
      allowOutsideProject: deps.config.allowOutsideProject,
      ...(deps.fs ? { fs: deps.fs } : {}),
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    })
    if (!resolved.ok) return { ok: false, message: resolved.message }
    let target: ResolvedTarget = resolved
    if (req.line !== undefined && Number.isInteger(req.line) && req.line > 0) {
      const { col: _c, ...rest } = target
      target = { ...rest, line: req.line, ...(req.col !== undefined && req.col > 0 ? { col: req.col } : {}) }
    }

    const chosen = chooseAction(deps.config, target.line !== undefined, req.action)
    let action = chosen.action
    let note = chosen.fellBack ? " (no editor configured)" : ""
    let warning: string | undefined
    if (action === "open" && isExecutableLike(target.path, deps.platform)) {
      action = "reveal"
      warning = `${target.display} looks executable; revealed it instead of opening it`
      note = " (executable: not opened)"
    }
    const env = deps.env ?? process.env

    const build = async (a: Action): Promise<{ commands: Command[]; errors: string[] }> => {
      let winPath: string | undefined
      if (deps.platform === "wsl" && a !== "editor") {
        winPath = (await (deps.wslpath ?? defaultWslpath)(target.path)) ?? wslToWindowsPath(target.path, env.WSL_DISTRO_NAME)
      }
      const commands = buildCommands({
        action: a,
        platform: deps.platform,
        path: target.path,
        isDirectory: target.isDirectory,
        ...(target.line !== undefined ? { line: target.line } : {}),
        ...(target.col !== undefined ? { col: target.col } : {}),
        ...(deps.config.editor ? { editor: deps.config.editor } : {}),
        ...(winPath ? { winPath } : {}),
      })
      if (deps.platform !== "win32") return { commands, errors: [] }
      return resolveWindowsCommands(commands, { env, ...(deps.isFile ? { isFile: deps.isFile } : {}) })
    }

    let { commands, errors } = await build(action)
    if (commands.length === 0 && action === "editor" && errors.length > 0) {
      // Windows editor that cannot be started safely: fall back to the plain action.
      const fallback: Action = deps.config.action !== "editor" ? deps.config.action : "reveal"
      warning = `Editor not started: ${errors.join("; ")}`
      action = fallback === "open" && isExecutableLike(target.path, deps.platform) ? "reveal" : fallback
      note = " (editor unavailable)"
      ;({ commands, errors } = await build(action))
    }
    if (commands.length === 0) {
      return {
        ok: false,
        action,
        target,
        message: `Cannot ${action} ${target.display}: ${errors.length > 0 ? errors.join("; ") : "no suitable command (unsupported path or platform)"}`,
      }
    }
    const result = await runCommands(commands, deps.exec)
    if (!result.ok) {
      const hint =
        deps.platform === "linux" && action !== "editor" && !env.DISPLAY && !env.WAYLAND_DISPLAY
          ? " (no graphical session: DISPLAY and WAYLAND_DISPLAY are not set for this process)"
          : ""
      return {
        ok: false,
        action,
        target,
        attempts: result.attempts,
        message: `Failed to ${action} ${target.display}: ${result.message}${hint}`,
      }
    }
    return {
      ok: true,
      action,
      target,
      attempts: result.attempts,
      message: `${describe(action, target)}${note}`,
      ...(warning ? { warning } : {}),
    }
  } catch (err) {
    return { ok: false, message: `opencode-filelink: ${(err as Error)?.message ?? String(err)}` }
  }
}

import type { FilelinkConfig } from "../config.js"
import type { Action } from "../types.js"
import { buildCommands, wslToWindowsPath } from "./commands.js"
import { type Attempt, wslpath as defaultWslpath, type ExecOptions, runCommands } from "./exec.js"
import type { Platform } from "./platform.js"
import { type ResolvedTarget, type ResolverFs, resolveTarget } from "./resolve.js"

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
}

export interface OpenOutcome {
  readonly ok: boolean
  readonly message: string
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

    const { action, fellBack } = chooseAction(deps.config, target.line !== undefined, req.action)
    let winPath: string | undefined
    if (deps.platform === "wsl" && action !== "editor") {
      winPath =
        (await (deps.wslpath ?? defaultWslpath)(target.path)) ?? wslToWindowsPath(target.path, (deps.env ?? process.env).WSL_DISTRO_NAME)
    }
    const commands = buildCommands({
      action,
      platform: deps.platform,
      path: target.path,
      isDirectory: target.isDirectory,
      ...(target.line !== undefined ? { line: target.line } : {}),
      ...(target.col !== undefined ? { col: target.col } : {}),
      ...(deps.config.editor ? { editor: deps.config.editor } : {}),
      ...(winPath ? { winPath } : {}),
    })
    if (commands.length === 0) {
      return {
        ok: false,
        action,
        target,
        message: `Cannot ${action} ${target.display}: no suitable command (unsupported path or platform)`,
      }
    }
    const result = await runCommands(commands, deps.exec)
    if (!result.ok) {
      return { ok: false, action, target, attempts: result.attempts, message: `Failed to ${action} ${target.display}: ${result.message}` }
    }
    const note = fellBack ? " (no editor configured)" : ""
    return { ok: true, action, target, attempts: result.attempts, message: `${describe(action, target)}${note}` }
  } catch (err) {
    return { ok: false, message: `opencode-filelink: ${(err as Error)?.message ?? String(err)}` }
  }
}

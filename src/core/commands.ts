import * as nodePath from "node:path"
import type { Action } from "../types.js"
import { type EditorTemplate, renderEditorArgs } from "./editor.js"
import type { Platform } from "./platform.js"

/** One candidate command. The executor tries them in order until one works. */
export interface Command {
  readonly cmd: string
  readonly args: readonly string[]
  /** Windows only: pass `args` to CreateProcess unquoted (we quote ourselves). */
  readonly verbatim?: boolean
  /**
   * Wait for the process to exit and treat a non-zero exit code as failure
   * (falls through to the next command). Used for short-lived DBus calls.
   */
  readonly wait?: boolean
  /** Extra environment variables for the child (merged over the parent's). */
  readonly env?: Readonly<Record<string, string>>
}

export interface BuildInput {
  readonly action: Action
  readonly platform: Platform
  /** Absolute path on the platform's own file system. */
  readonly path: string
  readonly isDirectory: boolean
  readonly line?: number
  readonly col?: number
  /** Required for action "editor". */
  readonly editor?: EditorTemplate
  /** WSL only: Windows form of `path` (from `wslpath -w`). */
  readonly winPath?: string
}

/** RFC 8089 file URI with every byte outside unreserved/"/" percent-encoded (safe for DBus and GVariant syntax). */
export function toFileUri(absPosixPath: string): string {
  const encoded = absPosixPath
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/")
  return `file://${encoded}`
}

/** Fallback when `wslpath` is unavailable: /mnt/c/x → C:\x, else \\wsl.localhost\<distro>\x. */
export function wslToWindowsPath(posixPath: string, distro: string | undefined): string {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posixPath)
  if (m) return `${(m[1] as string).toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`
  return `\\\\wsl.localhost\\${distro ?? "Ubuntu"}${posixPath.replace(/\//g, "\\")}`
}

/** Characters Windows forbids in paths; `"` in particular would break our quoting. */
export function isSafeWindowsPath(p: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  return !/["<>|*?\u0000-\u001f]/.test(p.replace(/^\\\\\?\\/, ""))
}

function linuxReveal(path: string): Command[] {
  const uri = toFileUri(path)
  const parent = nodePath.posix.dirname(path)
  return [
    {
      cmd: "busctl",
      args: [
        "--user",
        "call",
        "org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1",
        "ShowItems",
        "ass",
        "1",
        uri,
        "",
      ],
      wait: true,
    },
    {
      cmd: "gdbus",
      args: [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        `['${uri}']`,
        "",
      ],
      wait: true,
    },
    {
      cmd: "dbus-send",
      args: [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:${uri.replace(/,/g, "%2C")}`,
        "string:",
      ],
      wait: true,
    },
    // xdg-open/gio exit non-zero without a usable session (no DISPLAY, headless
    // server): wait for the exit code so the failure is reported, not hidden.
    { cmd: "xdg-open", args: [parent], wait: true },
    { cmd: "gio", args: ["open", parent], wait: true },
  ]
}

function editorCommands(input: BuildInput, platform: Platform): Command[] {
  if (!input.editor || input.editor.length === 0) return []
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix
  const argv = renderEditorArgs(input.editor, {
    file: input.path,
    dir: input.isDirectory ? input.path : p.dirname(input.path),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.col !== undefined ? { col: input.col } : {}),
  })
  const [cmd, ...args] = argv
  if (!cmd) return []
  // Windows: the opener resolves `cmd` to an absolute .exe (winexe.ts); batch shims are never run.
  return [{ cmd, args }]
}

/**
 * Pure: the ordered fallback chain of commands for an action on a platform.
 * Returns [] when nothing can be done (e.g. "editor" without a template, unsafe Windows path).
 */
export function buildCommands(input: BuildInput): Command[] {
  const { action, platform, path } = input
  if (action === "editor") return editorCommands(input, platform)

  switch (platform) {
    case "linux":
      if (action === "reveal") return linuxReveal(path)
      return [
        { cmd: "xdg-open", args: [path], wait: true },
        { cmd: "gio", args: ["open", path], wait: true },
      ]
    case "darwin":
      // `open` returns quickly and exits non-zero when it cannot (no GUI session, no handler).
      return action === "reveal" ? [{ cmd: "open", args: ["-R", path], wait: true }] : [{ cmd: "open", args: [path], wait: true }]
    case "win32": {
      if (!isSafeWindowsPath(path)) return []
      // A drive or share root ("C:\\") would end in `\"`, which reads as an escaped quote; open it instead.
      if (/[\\/]$/.test(path)) return [{ cmd: "explorer.exe", args: [`"${path}."`], verbatim: true }]
      // explorer.exe exits with 1 even on success: never wait for it.
      // `cmd` is resolved to %SystemRoot%\\explorer.exe by the opener (never the current directory).
      return action === "reveal"
        ? [{ cmd: "explorer.exe", args: [`/select,"${path}"`], verbatim: true }]
        : [{ cmd: "explorer.exe", args: [`"${path}"`], verbatim: true }]
    }
    case "wsl": {
      const win = input.winPath ?? wslToWindowsPath(path, undefined)
      if (!isSafeWindowsPath(win)) return []
      if (action === "reveal") return [{ cmd: "explorer.exe", args: [`/select,${win}`] }]
      // Not `wslview`: wslu hands the path to `powershell.exe -Command "Start \"<path>\""`,
      // where `$(...)` or a backtick in a (legal) file name is evaluated.
      return [{ cmd: "explorer.exe", args: [win] }]
    }
  }
}

/**
 * Editor command templates. A template is an argv array with placeholders
 * `{file}`, `{line}`, `{col}` and `{dir}`, substituted per element. Elements
 * are never joined into a command line or passed to a shell.
 */

export type EditorTemplate = readonly string[]

export const EDITOR_PRESETS: Readonly<Record<string, EditorTemplate>> = {
  vscode: ["code", "-g", "{file}:{line}:{col}"],
  code: ["code", "-g", "{file}:{line}:{col}"],
  "code-insiders": ["code-insiders", "-g", "{file}:{line}:{col}"],
  vscodium: ["codium", "-g", "{file}:{line}:{col}"],
  codium: ["codium", "-g", "{file}:{line}:{col}"],
  cursor: ["cursor", "-g", "{file}:{line}:{col}"],
  windsurf: ["windsurf", "-g", "{file}:{line}:{col}"],
  zed: ["zed", "{file}:{line}:{col}"],
  subl: ["subl", "{file}:{line}:{col}"],
  sublime: ["subl", "{file}:{line}:{col}"],
  idea: ["idea", "--line", "{line}", "--column", "{col}", "{file}"],
  webstorm: ["webstorm", "--line", "{line}", "--column", "{col}", "{file}"],
  pycharm: ["pycharm", "--line", "{line}", "--column", "{col}", "{file}"],
  goland: ["goland", "--line", "{line}", "--column", "{col}", "{file}"],
}

/** Editors that need the terminal opencode is using. They cannot run detached. */
export const TERMINAL_EDITORS: ReadonlySet<string> = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "micro",
  "hx",
  "helix",
  "kak",
  "joe",
  "ne",
  "mg",
  "ed",
  "emacsclient-nw",
  "less",
  "more",
])

/** Split a command template into argv like a POSIX shell would, without any expansion. */
export function tokenize(template: string): string[] {
  const out: string[] = []
  let cur = ""
  let has = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < template.length; i++) {
    const ch = template[i] as string
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && (template[i + 1] === '"' || template[i + 1] === "\\")) {
        cur += template[++i]
      } else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === "\\" && i + 1 < template.length && /[\s"'\\]/.test(template[i + 1] as string)) {
      cur += template[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ""
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) throw new Error(`Unterminated quote in editor command: ${template}`)
  if (has) out.push(cur)
  return out
}

function commandBase(cmd: string): string {
  const base = cmd.split(/[\\/]/).pop() ?? cmd
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase()
}

export function isTerminalEditor(argv: readonly string[]): boolean {
  const first = argv[0]
  if (!first) return false
  const base = commandBase(first)
  if (TERMINAL_EDITORS.has(base)) return true
  if (base === "emacs" && argv.some((a) => a === "-nw" || a === "-t" || a === "--no-window-system")) return true
  return false
}

/**
 * Turn the `editor` option (preset name, template string or argv array) into
 * a template. Throws with a helpful message for invalid input.
 */
export function parseEditorOption(value: string | readonly string[]): EditorTemplate {
  let argv: string[]
  if (typeof value === "string") {
    const trimmed = value.trim()
    const preset = EDITOR_PRESETS[trimmed.toLowerCase()]
    if (preset) return preset
    argv = tokenize(trimmed)
  } else {
    argv = value.map(String)
  }
  if (argv.length === 0 || !argv[0]) throw new Error("editor command is empty")
  if (isTerminalEditor(argv)) {
    throw new Error(
      `editor "${argv[0]}" runs in the terminal and would fight the opencode TUI; wrap it in a terminal window, e.g. "kitty -e nvim +{line} {file}"`,
    )
  }
  if (!argv.some((a) => a.includes("{file}") || a.includes("{dir}"))) argv.push("{file}")
  return argv
}

/**
 * Build a template from `$VISUAL` / `$EDITOR`. Known GUI editors get their
 * line-jump preset; unknown commands get the file appended; terminal editors
 * are rejected (returns undefined).
 */
export function editorFromEnv(env: Readonly<Record<string, string | undefined>>): EditorTemplate | undefined {
  for (const key of ["VISUAL", "EDITOR"] as const) {
    const value = env[key]?.trim()
    if (!value) continue
    let argv: string[]
    try {
      argv = tokenize(value)
    } catch {
      continue
    }
    const first = argv[0]
    if (!first || isTerminalEditor(argv)) continue
    const preset = EDITOR_PRESETS[commandBase(first)]
    if (preset) return [first, ...preset.slice(1)]
    return [...argv.filter((a) => a !== "--wait" && a !== "-w"), "{file}"]
  }
  return undefined
}

export interface EditorVars {
  readonly file: string
  readonly dir: string
  readonly line?: number
  readonly col?: number
}

/**
 * Substitute placeholders. Without a line, `:{line}` / `:{col}` suffixes are
 * removed and stand-alone `{line}`/`{col}` elements are dropped together with
 * a preceding flag (`--line {line}`, `+{line}`). A missing column defaults to
 * removing the `:{col}` part.
 */
export function renderEditorArgs(template: EditorTemplate, vars: EditorVars): string[] {
  const out: string[] = []
  for (const element of template) {
    let el = element
    for (const [name, value] of [
      ["line", vars.line],
      ["col", vars.line !== undefined ? vars.col : undefined],
    ] as const) {
      if (value !== undefined) continue
      if (el === `{${name}}` || el === `+{${name}}`) {
        const prev = out[out.length - 1]
        if (el === `{${name}}` && prev?.startsWith("-") && !prev.includes("{")) out.pop()
        el = ""
        break
      }
      el = el.replaceAll(`:{${name}}`, "").replaceAll(`{${name}}`, "")
    }
    if (el === "" && element !== "") continue
    // Single pass, so placeholder-like text inside a file name is never substituted again.
    out.push(
      el.replace(/\{(file|dir|line|col)\}/g, (_, k: string) => {
        if (k === "file") return vars.file
        if (k === "dir") return vars.dir
        if (k === "line") return String(vars.line ?? "")
        return String(vars.col ?? "")
      }),
    )
  }
  return out
}

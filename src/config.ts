import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { fileURLToPath } from "node:url"
import { type EditorTemplate, editorFromEnv, parseEditorOption } from "./core/editor.js"
import type { Action } from "./types.js"

export const PACKAGE_NAME = "@daropotter/opencode-filelink"
export const PLUGIN_ID = "opencode-filelink"

const ACTIONS: readonly Action[] = ["reveal", "open", "editor"]
const LINK_REWRITE = ["off", "instruct"] as const
export type LinkRewrite = (typeof LINK_REWRITE)[number]

/** Resolved, validated configuration. Keep in sync with the README options table. */
export interface FilelinkConfig {
  /** What a click on a link without a line number does. */
  readonly action: Action
  /** What a click on a link with a line number does. Default: "editor" when an editor is available, else `action`. */
  readonly lineAction?: Action
  /** Editor argv template (from `editor`, or `$VISUAL`/`$EDITOR` when `editorFromEnv`). */
  readonly editor?: EditorTemplate
  /** Fall back to `$VISUAL` / `$EDITOR` when `editor` is unset. */
  readonly editorFromEnv: boolean
  readonly allowOutsideProject: boolean
  /** Additional allowed directories (absolute, or relative to the project; `~/` expanded). */
  readonly extraRoots: readonly string[]
  /** TUI: intercept clicks on local links. */
  readonly intercept: boolean
  /** TUI: show a toast on success (errors are always shown). */
  readonly toast: boolean
  /** TUI: keybinding for the /links command, or false. */
  readonly keybind: string | false
  readonly bridge: { readonly enabled: boolean; readonly port: number }
  readonly linkRewrite: LinkRewrite
  /** Server: register the open_file / reveal_file agent tools. */
  readonly tools: boolean
}

export const DEFAULTS: FilelinkConfig = {
  action: "reveal",
  editorFromEnv: false,
  allowOutsideProject: false,
  extraRoots: [],
  intercept: true,
  toast: true,
  keybind: false,
  bridge: { enabled: true, port: 0 },
  linkRewrite: "off",
  tools: true,
}

const KNOWN_KEYS = new Set([
  "action",
  "lineAction",
  "editor",
  "editorFromEnv",
  "allowOutsideProject",
  "extraRoots",
  "intercept",
  "toast",
  "keybind",
  "bridge",
  "linkRewrite",
  "tools",
])

type Raw = Record<string, unknown>

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Shallow merge with one level of deep merge for nested objects (`bridge`). */
export function mergeOptions(...layers: readonly (Raw | undefined)[]): Raw {
  const out: Raw = {}
  for (const layer of layers) {
    if (!isObject(layer)) continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      const prev = out[k]
      out[k] = isObject(prev) && isObject(v) ? { ...prev, ...v } : v
    }
  }
  return out
}

export interface ValidateContext {
  readonly projectDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
}

/** Validate raw options. Bad values are ignored (the default is used) with a warning. */
export function validateOptions(raw: unknown, ctx: ValidateContext = {}): { config: FilelinkConfig; warnings: string[] } {
  const warnings: string[] = []
  const o = isObject(raw) ? raw : {}
  if (raw !== undefined && !isObject(raw)) warnings.push(`options must be an object, got ${typeof raw}`)
  const bad = (key: string, expected: string) =>
    warnings.push(`ignoring invalid "${key}": expected ${expected}, got ${JSON.stringify(o[key])}`)

  for (const key of Object.keys(o)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown option "${key}" ignored`)
  }

  const pickEnum = <T extends string>(key: string, allowed: readonly T[], dflt: T): T => {
    const v = o[key]
    if (v === undefined) return dflt
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T
    bad(key, allowed.map((a) => `"${a}"`).join(" | "))
    return dflt
  }
  const pickBool = (key: string, dflt: boolean): boolean => {
    const v = o[key]
    if (v === undefined) return dflt
    if (typeof v === "boolean") return v
    bad(key, "boolean")
    return dflt
  }

  const action = pickEnum("action", ACTIONS, DEFAULTS.action)
  let lineAction: Action | undefined
  if (o.lineAction !== undefined) {
    if (typeof o.lineAction === "string" && (ACTIONS as readonly string[]).includes(o.lineAction)) {
      lineAction = o.lineAction as Action
    } else bad("lineAction", ACTIONS.map((a) => `"${a}"`).join(" | "))
  }
  const editorFromEnvFlag = pickBool("editorFromEnv", DEFAULTS.editorFromEnv)

  let editor: EditorTemplate | undefined
  if (o.editor !== undefined && o.editor !== null && o.editor !== false) {
    const v = o.editor
    if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) {
      try {
        editor = parseEditorOption(v as string | string[])
      } catch (err) {
        warnings.push(`ignoring invalid "editor": ${(err as Error).message}`)
      }
    } else bad("editor", "a command string or an array of strings")
  }
  if (!editor && editorFromEnvFlag) editor = editorFromEnv(ctx.env ?? process.env)

  const extraRoots: string[] = []
  if (o.extraRoots !== undefined) {
    if (Array.isArray(o.extraRoots) && o.extraRoots.every((x) => typeof x === "string")) {
      const home = ctx.homeDir ?? os.homedir()
      for (const r of o.extraRoots as string[]) {
        let p = r === "~" ? home : r.startsWith("~/") ? nodePath.join(home, r.slice(2)) : r
        if (!nodePath.isAbsolute(p)) {
          if (!ctx.projectDir) {
            warnings.push(`ignoring relative extraRoots entry "${r}" (no project directory)`)
            continue
          }
          p = nodePath.resolve(ctx.projectDir, p)
        }
        extraRoots.push(p)
      }
    } else bad("extraRoots", "an array of strings")
  }

  let keybind: string | false = DEFAULTS.keybind
  if (o.keybind !== undefined) {
    if (o.keybind === false || (typeof o.keybind === "string" && o.keybind.trim() !== "")) keybind = o.keybind as string | false
    else bad("keybind", "a key binding string or false")
  }

  let bridge = DEFAULTS.bridge
  if (o.bridge !== undefined) {
    if (typeof o.bridge === "boolean") bridge = { ...bridge, enabled: o.bridge }
    else if (isObject(o.bridge)) {
      let enabled = bridge.enabled
      let port = bridge.port
      for (const key of Object.keys(o.bridge)) {
        if (key !== "enabled" && key !== "port") warnings.push(`unknown option "bridge.${key}" ignored`)
      }
      const b = o.bridge
      if (b.enabled !== undefined) {
        if (typeof b.enabled === "boolean") enabled = b.enabled
        else warnings.push(`ignoring invalid "bridge.enabled": expected boolean, got ${JSON.stringify(b.enabled)}`)
      }
      if (b.port !== undefined) {
        if (typeof b.port === "number" && Number.isInteger(b.port) && b.port >= 0 && b.port <= 65535) port = b.port
        else warnings.push(`ignoring invalid "bridge.port": expected an integer 0-65535, got ${JSON.stringify(b.port)}`)
      }
      bridge = { enabled, port }
    } else bad("bridge", "an object { enabled, port } or boolean")
  }

  const config: FilelinkConfig = {
    action,
    ...(lineAction ? { lineAction } : {}),
    ...(editor ? { editor } : {}),
    editorFromEnv: editorFromEnvFlag,
    allowOutsideProject: pickBool("allowOutsideProject", DEFAULTS.allowOutsideProject),
    extraRoots,
    intercept: pickBool("intercept", DEFAULTS.intercept),
    toast: pickBool("toast", DEFAULTS.toast),
    keybind,
    bridge,
    linkRewrite: pickEnum("linkRewrite", LINK_REWRITE, DEFAULTS.linkRewrite),
    tools: pickBool("tools", DEFAULTS.tools),
  }
  return { config, warnings }
}

/** Strip `//` and `/* *\/` comments and trailing commas from JSONC, preserving strings. */
export function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? n : end + 2
      out += " "
    } else {
      out += ch
      i++
    }
  }
  return removeTrailingCommas(out)
}

function removeTrailingCommas(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < n && /\s/.test(text[j] as string)) j++
      if (text[j] === "}" || text[j] === "]") {
        i++
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text.replace(/^﻿/, "")))
}

export interface ConfigFs {
  readFileSync(p: string, enc: "utf8"): string
  existsSync(p: string): boolean
}

function isLocalSpec(spec: string): boolean {
  return /^(\.{1,2}([\\/]|$)|\/|~[\\/]|file:|[A-Za-z]:[\\/])/.test(spec)
}

/** Does a `plugins` entry spec refer to this package? */
export function specMatchesPackage(spec: string, configDir: string, fs: ConfigFs = nodeFs, homeDir = os.homedir()): boolean {
  let s = spec.trim()
  if (s.startsWith("npm:")) s = s.slice(4)
  if (s === PACKAGE_NAME || s.startsWith(`${PACKAGE_NAME}@`)) return true
  if (isLocalSpec(s)) {
    let dir: string
    try {
      if (s.startsWith("file:")) dir = fileURLToPath(s)
      else if (s.startsWith("~")) dir = nodePath.join(homeDir, s.slice(2))
      else dir = nodePath.resolve(configDir, s)
      const pkg = JSON.parse(fs.readFileSync(nodePath.join(dir, "package.json"), "utf8")) as { name?: unknown }
      return pkg.name === PACKAGE_NAME
    } catch {
      return false
    }
  }
  // github:owner/opencode-filelink, owner/opencode-filelink#ref, git+https://.../opencode-filelink.git
  return /(^|[/:])opencode-filelink(\.git)?(#.*)?$/.test(s)
}

/** Find this plugin's options in a parsed opencode config object. */
export function findPluginOptions(config: unknown, configDir: string, fs: ConfigFs = nodeFs, homeDir?: string): Raw | undefined {
  if (!isObject(config)) return undefined
  let found: Raw | undefined
  for (const key of ["plugin", "plugins"]) {
    const list = config[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      let spec: unknown
      let options: unknown
      if (isObject(entry)) {
        spec = entry.package
        options = entry.options
      } else if (Array.isArray(entry)) {
        spec = entry[0]
        options = entry[1]
      } else continue
      if (typeof spec !== "string" || !specMatchesPackage(spec, configDir, fs, homeDir)) continue
      if (isObject(options)) found = mergeOptions(found, options)
      else found ??= {}
    }
  }
  return found
}

export interface ConfigSource {
  readonly file: string
  readonly options: Raw
}

export interface LoadConfigInput {
  /** Project (location) directory; project config files are looked up from here up to the git root. */
  readonly projectDir?: string
  /** Options passed to setup (highest precedence). */
  readonly setupOptions?: unknown
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly fs?: ConfigFs
}

export interface LoadedConfig {
  readonly config: FilelinkConfig
  readonly warnings: readonly string[]
  readonly sources: readonly ConfigSource[]
}

/** Config files in increasing precedence. */
export function configFileCandidates(input: LoadConfigInput): string[] {
  const env = input.env ?? process.env
  const fs = input.fs ?? nodeFs
  const home = input.homeDir ?? os.homedir()
  const files: string[] = []
  const globalDir = env.OPENCODE_CONFIG_DIR || nodePath.join(env.XDG_CONFIG_HOME || nodePath.join(home, ".config"), "opencode")
  for (const name of ["opencode.json", "opencode.jsonc", "cli.json", "cli.jsonc"]) files.push(nodePath.join(globalDir, name))
  if (env.OPENCODE_CONFIG) files.push(nodePath.resolve(env.OPENCODE_CONFIG))

  if (input.projectDir && nodePath.isAbsolute(input.projectDir)) {
    // Walk up to the git root (inclusive) or at most 8 levels; outer directories first.
    const dirs: string[] = []
    let dir = input.projectDir
    for (let i = 0; i < 8; i++) {
      dirs.push(dir)
      if (fs.existsSync(nodePath.join(dir, ".git"))) break
      const parent = nodePath.dirname(dir)
      if (parent === dir || dir === home) break
      dir = parent
    }
    // Without a git root only the project directory itself counts.
    const last = dirs[dirs.length - 1] as string
    const useDirs = fs.existsSync(nodePath.join(last, ".git")) ? dirs : dirs.slice(0, 1)
    for (const d of useDirs.reverse()) {
      if (nodePath.resolve(d) === nodePath.resolve(globalDir)) continue
      for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
        files.push(nodePath.join(d, name))
      }
    }
  }
  return [...new Set(files)]
}

/**
 * Resolve the effective configuration: defaults < global config < project
 * config < options passed to setup. Never throws.
 */
export function loadConfig(input: LoadConfigInput = {}): LoadedConfig {
  const fs = input.fs ?? nodeFs
  const warnings: string[] = []
  const sources: ConfigSource[] = []
  let files: string[] = []
  try {
    files = configFileCandidates(input)
  } catch (err) {
    warnings.push(`could not list config files: ${(err as Error).message}`)
  }
  for (const file of files) {
    let text: string
    try {
      if (!fs.existsSync(file)) continue
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    try {
      const opts = findPluginOptions(parseJsonc(text), nodePath.dirname(file), fs, input.homeDir)
      if (opts && Object.keys(opts).length > 0) sources.push({ file, options: opts })
    } catch (err) {
      warnings.push(`could not parse ${file}: ${(err as Error).message}`)
    }
  }
  const setup = isObject(input.setupOptions) ? input.setupOptions : undefined
  const merged = mergeOptions(...sources.map((s) => s.options), setup)
  const { config, warnings: w } = validateOptions(merged, {
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  return { config, warnings: [...warnings, ...w], sources }
}

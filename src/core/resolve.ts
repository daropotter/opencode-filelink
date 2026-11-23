import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { parseHref } from "./href.js"

/** Synchronous file system subset used by the resolver (injectable for tests). */
export interface ResolverFs {
  realpathSync(p: string): string
  statSync(p: string): { isDirectory(): boolean }
}

export interface ResolveOptions {
  /** Directory relative links are resolved against (session or project directory). */
  readonly baseDir: string
  /** Allowed roots. The base directory is always allowed. */
  readonly roots?: readonly string[]
  readonly allowOutsideProject?: boolean
  readonly homeDir?: string
  readonly fs?: ResolverFs
  readonly path?: typeof nodePath
}

export interface ResolvedTarget {
  readonly ok: true
  /** Absolute, symlink-resolved path. */
  readonly path: string
  readonly isDirectory: boolean
  readonly line?: number
  readonly col?: number
  /** Short path for messages (relative to the base dir when inside it). */
  readonly display: string
}

export type ResolveErrorCode = "not-local" | "not-found" | "outside-project" | "invalid"

export interface ResolveError {
  readonly ok: false
  readonly code: ResolveErrorCode
  readonly message: string
  readonly path?: string
}

export type ResolveResult = ResolvedTarget | ResolveError

/** True when `child` is `root` or inside it. Both must be absolute and normalised. */
export function isInside(root: string, child: string, p: typeof nodePath = nodePath): boolean {
  const caseless = p.sep === "\\"
  const r = caseless ? root.toLowerCase() : root
  const c = caseless ? child.toLowerCase() : child
  const rel = p.relative(r, c)
  if (rel === "") return true
  if (p.isAbsolute(rel)) return false
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !rel.startsWith("../")
}

function expandHome(input: string, home: string, p: typeof nodePath): string {
  if (input === "~") return home
  if (input.startsWith("~/") || input.startsWith("~\\")) return p.join(home, input.slice(2))
  return input
}

export function displayPath(abs: string, baseDir: string, p: typeof nodePath = nodePath): string {
  if (isInside(baseDir, abs, p)) {
    const rel = p.relative(baseDir, abs)
    return rel === "" ? "." : rel
  }
  return abs
}

/**
 * Resolve an href (or a plain path from the agent tool) to an existing local
 * file or directory and enforce the project-boundary policy.
 */
export function resolveTarget(href: string, opts: ResolveOptions): ResolveResult {
  const p = opts.path ?? nodePath
  const fs = opts.fs ?? nodeFs
  const home = opts.homeDir ?? os.homedir()
  const parsed = parseHref(href)
  if (!parsed) {
    return { ok: false, code: "not-local", message: `Not a local file link: ${href}` }
  }
  if (!p.isAbsolute(opts.baseDir)) {
    return { ok: false, code: "invalid", message: `Base directory is not absolute: ${opts.baseDir}` }
  }

  // Allowed roots, both as written and symlink-resolved. Computed up front so
  // candidates outside them are rejected *before* touching the file system:
  // no existence probing outside the project, and on Windows no stat of a
  // `\\host\share` path (which would send NTLM credentials to that host).
  const lexicalRoots: string[] = []
  const realRoots: string[] = []
  for (const root of [opts.baseDir, ...(opts.roots ?? [])]) {
    if (!root || !p.isAbsolute(root)) continue
    const abs = p.resolve(root)
    lexicalRoots.push(abs)
    try {
      realRoots.push(fs.realpathSync(abs))
    } catch {
      realRoots.push(abs)
    }
  }
  const allRoots = [...lexicalRoots, ...realRoots]
  const insideRoots = (abs: string) => allRoots.some((root) => isInside(root, abs, p))
  // `\\server\share`, `\\?\…`, `\\.\…` (and `//…`) under Windows path rules.
  const isNetworkOrDevice = (abs: string) => p.sep === "\\" && /^[\\/]{2}/.test(abs)

  let firstAbs: string | undefined
  let refused: { abs: string; network: boolean } | undefined
  let found: { real: string; isDirectory: boolean; line?: number; col?: number } | undefined
  for (const c of parsed.candidates) {
    if (c.path.includes("\u0000")) continue
    const abs = p.resolve(opts.baseDir, expandHome(c.path, home, p))
    firstAbs ??= abs
    const network = isNetworkOrDevice(abs)
    if ((!opts.allowOutsideProject || network) && !insideRoots(abs)) {
      refused ??= { abs, network }
      continue
    }
    let real: string
    let isDirectory: boolean
    try {
      real = fs.realpathSync(abs)
      isDirectory = fs.statSync(real).isDirectory()
    } catch {
      continue
    }
    found = { real, isDirectory }
    if (c.line !== undefined) found.line = c.line
    if (c.col !== undefined) found.col = c.col
    break
  }

  if (!found) {
    if (refused) {
      return {
        ok: false,
        code: "outside-project",
        path: refused.abs,
        message: refused.network
          ? `Refusing to open a network or device path: ${refused.abs} (add its share to extraRoots to allow)`
          : `Refusing to open a path outside the project: ${refused.abs} (set allowOutsideProject: true to allow)`,
      }
    }
    const shown = firstAbs ? displayPath(firstAbs, opts.baseDir, p) : href
    const r: ResolveError = { ok: false, code: "not-found", message: `File not found: ${shown}` }
    return firstAbs ? { ...r, path: firstAbs } : r
  }

  // A symlink inside a root may still point outside: check the resolved path too.
  if (!opts.allowOutsideProject && !realRoots.some((root) => isInside(root, found.real, p))) {
    return {
      ok: false,
      code: "outside-project",
      path: found.real,
      message: `Refusing to open a path outside the project: ${found.real} (set allowOutsideProject: true to allow)`,
    }
  }
  if (isNetworkOrDevice(found.real) && !realRoots.some((root) => isInside(root, found.real, p))) {
    return {
      ok: false,
      code: "outside-project",
      path: found.real,
      message: `Refusing to open a network or device path: ${found.real} (add its share to extraRoots to allow)`,
    }
  }

  const result: ResolvedTarget = {
    ok: true,
    path: found.real,
    isDirectory: found.isDirectory,
    display: displayPath(found.real, safeReal(fs, opts.baseDir), p),
    ...(found.line !== undefined ? { line: found.line } : {}),
    ...(found.col !== undefined ? { col: found.col } : {}),
  }
  return result
}

function safeReal(fs: ResolverFs, p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

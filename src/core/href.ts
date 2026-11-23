/**
 * Link classification and parsing. Pure string functions: no file system access.
 */

export interface ParsedHref {
  /** The original href, untouched. */
  readonly href: string
  /** Path candidates in priority order (decoded first, raw second, suffix-stripped variants after). */
  readonly candidates: readonly PathCandidate[]
  /** Where the path came from. */
  readonly kind: "relative" | "absolute" | "home" | "file-url" | "windows" | "unc"
}

export interface PathCandidate {
  readonly path: string
  readonly line?: number
  readonly col?: number
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\[^\\]/
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
/** Schemes whose URLs can look like `name:123`; never treated as `file:line`. */
const NUMERIC_SCHEMES = new Set(["tel", "sms", "fax", "callto", "geo", "urn", "news", "localhost", "port", "isbn"])

/**
 * True when `href` points at a local file: scheme-less paths, `~/`, absolute
 * POSIX/Windows/UNC paths and `file:` URLs. `http(s):`, `mailto:`, other
 * schemes, pure anchors (`#x`), queries and protocol-relative URLs are not local.
 */
export function isLocalFileHref(href: unknown): href is string {
  if (typeof href !== "string") return false
  const s = href.trim()
  if (s === "" || s.startsWith("#") || s.startsWith("?")) return false
  if (s.startsWith("//")) return false // protocol-relative URL
  if (WINDOWS_DRIVE.test(s) || UNC.test(s)) return true
  const m = SCHEME.exec(s)
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase()
    if (scheme === "file") return true
    // "README.md:42" / "main.go:42:7" look like a scheme to URL parsers but are file:line links.
    const rest = s.slice(m[0].length)
    if (scheme.length > 1 && !NUMERIC_SCHEMES.has(scheme) && /^\d+(?::\d+)?(?:[#?].*)?$/.test(rest)) return true
    // Anything else with a scheme (http, mailto, vscode, "C:foo", ...) is left alone.
    return false
  }
  // Reject anything with control characters.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  if (/[\u0000-\u001f]/.test(s)) return false
  return true
}

/** decodeURIComponent that never throws. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `#L42`, `#L42C7`, `#L42-L50`, `#L42:7`, `#42` → line/col. */
export function parseLineFragment(fragment: string): { line: number; col?: number } | undefined {
  const m = /^L?(\d+)(?:[C:](\d+))?(?:-L?\d+(?:[C:]\d+)?)?$/i.exec(fragment)
  if (!m) return undefined
  const line = Number(m[1])
  if (!Number.isSafeInteger(line) || line < 1) return undefined
  const col = m[2] !== undefined ? Number(m[2]) : undefined
  return col !== undefined && col >= 1 ? { line, col } : { line }
}

/** `path:42` / `path:42:7` → { path, line, col }. */
export function splitLineSuffix(p: string): PathCandidate | undefined {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(p)
  if (!m?.[1]) return undefined
  // Do not strip a bare Windows drive ("C:5" is not "C" + line 5).
  if (/^[A-Za-z]$/.test(m[1])) return undefined
  const line = Number(m[2])
  if (line < 1) return undefined
  const col = m[3] !== undefined ? Number(m[3]) : undefined
  return col !== undefined && col >= 1 ? { path: m[1], line, col } : { path: m[1], line }
}

function fileUrlToPathString(href: string): { path: string; fragment?: string } | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.protocol !== "file:") return undefined
  const host = url.hostname
  let p = safeDecode(url.pathname)
  if (/^\/[A-Za-z]:[\\/]/.test(p)) {
    p = p.slice(1) // file:///C:/x → C:/x
  } else if (host && host !== "localhost") {
    p = `\\\\${host}${p.replace(/\//g, "\\")}` // file://server/share → UNC
  }
  const fragment = url.hash ? url.hash.slice(1) : undefined
  return fragment !== undefined ? { path: p, fragment } : { path: p }
}

/**
 * Parse a local-file href into path candidates (the resolver tries them in
 * order and picks the first that exists). Returns undefined for non-local hrefs.
 */
export function parseHref(href: string): ParsedHref | undefined {
  if (!isLocalFileHref(href)) return undefined
  const raw = href.trim()

  let kind: ParsedHref["kind"]
  let body: string
  let fragment: string | undefined

  if (/^file:/i.test(raw)) {
    const r = fileUrlToPathString(raw)
    if (!r || r.path === "") return undefined
    kind = "file-url"
    body = r.path
    fragment = r.fragment
  } else {
    body = raw
    // Strip ?query and #fragment (a literal '#' or '?' in a filename must be percent-encoded).
    const hash = body.indexOf("#")
    if (hash >= 0) {
      fragment = body.slice(hash + 1)
      body = body.slice(0, hash)
    }
    const q = body.indexOf("?")
    if (q >= 0) body = body.slice(0, q)
    if (body === "") return undefined
    if (WINDOWS_DRIVE.test(body)) kind = "windows"
    else if (UNC.test(body)) kind = "unc"
    else if (body === "~" || body.startsWith("~/") || body.startsWith("~\\")) kind = "home"
    else if (body.startsWith("/")) kind = "absolute"
    else kind = "relative"
  }

  const fromFragment = fragment !== undefined ? parseLineFragment(fragment) : undefined
  const withFrag = (path: string): PathCandidate => (fromFragment ? { path, ...fromFragment } : { path })

  const variants: string[] = []
  const decoded = kind === "file-url" ? body : safeDecode(body)
  variants.push(decoded)
  if (decoded !== body) variants.push(body)

  const candidates: PathCandidate[] = []
  const seen = new Set<string>()
  const push = (c: PathCandidate) => {
    const key = `${c.path}\u0000${c.line ?? ""}\u0000${c.col ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }
  for (const v of variants) push(withFrag(v))
  // `path:42[:7]` suffixes are only tried after the full string (a file may really be named "x:1").
  if (!fromFragment) {
    for (const v of variants) {
      const s = splitLineSuffix(v)
      if (s) push(s)
    }
  }
  return { href, kind, candidates }
}

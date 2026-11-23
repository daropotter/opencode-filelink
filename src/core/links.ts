import { isLocalFileHref } from "./href.js"

export interface ExtractedLink {
  readonly href: string
  readonly text: string
}

/** Remove fenced code blocks and inline code spans so links inside code are ignored. */
function stripCode(markdown: string): string {
  return markdown.replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?(\n\s*\2[^\n]*|$(?![\s\S]))/gm, "$1").replace(/`[^`\n]*`/g, "")
}

/**
 * Extract local-file links from markdown: inline links and images
 * (`[t](href "title")`, `[t](<href with spaces>)`), reference definitions
 * (`[id]: href`) and `<file://...>` autolinks. Order of first appearance, de-duplicated.
 */
export function extractLocalLinks(markdown: string): ExtractedLink[] {
  const text = stripCode(markdown)
  const found: ExtractedLink[] = []
  const seen = new Set<string>()
  const add = (href: string, label: string) => {
    const h = href.trim()
    if (!h || seen.has(h) || !isLocalFileHref(h)) return
    seen.add(h)
    found.push({ href: h, text: label.trim() || h })
  }

  // Inline links/images. Label may contain one level of nested brackets.
  const inline =
    /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(?:<([^>\n]*)>|((?:[^()\s\\]|\\.|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
  // Reference definitions.
  const reference = /^[ ]{0,3}\[([^\]]+)\]:\s*(?:<([^>\n]*)>|(\S+))/gm
  // Autolinks: only file: URLs (scheme-less text in <> is HTML, not a link).
  const autolink = /<(file:[^>\s]+)>/gi

  const matches: { index: number; href: string; label: string }[] = []
  for (const m of text.matchAll(inline)) {
    matches.push({ index: m.index ?? 0, href: (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"), label: m[1] ?? "" })
  }
  for (const m of text.matchAll(reference)) {
    matches.push({ index: m.index ?? 0, href: m[2] ?? m[3] ?? "", label: m[1] ?? "" })
  }
  for (const m of text.matchAll(autolink)) {
    matches.push({ index: m.index ?? 0, href: m[1] ?? "", label: m[1] ?? "" })
  }
  matches.sort((a, b) => a.index - b.index)
  for (const m of matches) add(m.href, m.label)
  return found
}

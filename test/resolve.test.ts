import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { symlinkSync, writeFileSync } from "node:fs"
import { join, posix, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { displayPath, isInside, resolveTarget } from "../src/core/resolve.js"
import { tempTree } from "./helpers.js"

let project: ReturnType<typeof tempTree>
let outside: ReturnType<typeof tempTree>

beforeAll(() => {
  project = tempTree({
    "docs/report.md": "# r",
    "src/internal/file.go": "package x",
    "img/pic.png": "png",
    "reports/Kredyty i koszt runnerów.md": "x",
    "weird/100%.md": "x",
    "empty-dir": null,
  })
  outside = tempTree({ "secret.txt": "s", "home/notes.md": "n" })
  try {
    symlinkSync(join(outside.root, "secret.txt"), join(project.root, "link-out.txt"))
  } catch {
    // symlinks may be unavailable (Windows without privileges)
  }
})

afterAll(() => {
  project.cleanup()
  outside.cleanup()
})

const opts = () => ({ baseDir: project.root, homeDir: join(outside.root, "home") })

describe("resolveTarget", () => {
  test.each([
    ["docs/report.md", "docs/report.md"],
    ["./docs/report.md", "docs/report.md"],
    ["src/internal/file.go", "src/internal/file.go"],
    ["img/pic.png", "img/pic.png"],
    ["reports/Kredyty%20i%20koszt%20runner%C3%B3w.md", "reports/Kredyty i koszt runnerów.md"],
    ["weird/100%.md", "weird/100%.md"],
  ])("%s", (href, rel) => {
    const r = resolveTarget(href, opts())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path).toBe(join(project.root, rel))
      expect(r.isDirectory).toBe(false)
      expect(r.display).toBe(join(rel))
    }
  })

  test("line suffixes", () => {
    const a = resolveTarget("src/internal/file.go:42", opts())
    expect(a.ok && [a.line, a.col]).toEqual([42, undefined])
    const b = resolveTarget("src/internal/file.go:42:7", opts())
    expect(b.ok && [b.line, b.col]).toEqual([42, 7])
    const c = resolveTarget("src/internal/file.go#L12", opts())
    expect(c.ok && c.line).toBe(12)
  })

  test.skipIf(process.platform === "win32")("a file really named with a colon wins over a line suffix", () => {
    writeFileSync(join(project.root, "weird", "a:1"), "x")
    const r = resolveTarget("weird/a:1", opts())
    expect(r.ok && r.path).toBe(join(project.root, "weird", "a:1"))
    expect(r.ok && r.line).toBeUndefined()
  })

  test("directories", () => {
    const r = resolveTarget("empty-dir", opts())
    expect(r.ok && r.isDirectory).toBe(true)
    const d = resolveTarget("docs/", opts())
    expect(d.ok && d.isDirectory).toBe(true)
    const root = resolveTarget(".", opts())
    expect(root.ok && root.display).toBe(".")
  })

  test("absolute path and file:// URL inside the project", () => {
    const abs = join(project.root, "docs", "report.md")
    expect(resolveTarget(abs, opts()).ok).toBe(true)
    expect(resolveTarget(pathToFileURL(abs).href, opts()).ok).toBe(true)
  })

  test("missing file gives a clear error", () => {
    const r = resolveTarget("docs/missing.md", opts())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("not-found")
      expect(r.message).toBe(`File not found: ${join("docs", "missing.md")}`)
    }
  })

  test("outside the project is refused by default", () => {
    for (const href of [join(outside.root, "secret.txt"), pathToFileURL(join(outside.root, "secret.txt")).href, "~/notes.md", "../"]) {
      const r = resolveTarget(href, opts())
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe("outside-project")
        expect(r.message).toContain("allowOutsideProject")
      }
    }
  })

  test("outside the project is allowed with allowOutsideProject", () => {
    const r = resolveTarget("~/notes.md", { ...opts(), allowOutsideProject: true })
    expect(r.ok && r.path).toBe(join(outside.root, "home", "notes.md"))
    expect(r.ok && r.display).toBe(join(outside.root, "home", "notes.md"))
  })

  test("extra roots are allowed", () => {
    const r = resolveTarget(join(outside.root, "secret.txt"), { ...opts(), roots: [outside.root] })
    expect(r.ok).toBe(true)
  })

  test("symlink escaping the project is refused", () => {
    const r = resolveTarget("link-out.txt", opts())
    // If the symlink could not be created the file is simply missing.
    expect(r.ok).toBe(false)
  })

  test("non-local hrefs and invalid base dir", () => {
    expect(resolveTarget("https://x.y", opts())).toMatchObject({ ok: false, code: "not-local" })
    expect(resolveTarget("docs/report.md", { baseDir: "relative/dir" })).toMatchObject({ ok: false, code: "invalid" })
  })

  test("injected fs", () => {
    const fs = {
      realpathSync: (p: string) => {
        if (p === "/proj" || p === "/proj/a.txt") return p
        throw new Error("ENOENT")
      },
      statSync: () => ({ isDirectory: () => false }),
    }
    if (process.platform !== "win32") {
      expect(resolveTarget("a.txt", { baseDir: "/proj", fs })).toMatchObject({ ok: true, path: "/proj/a.txt", display: "a.txt" })
      expect(resolveTarget("b.txt", { baseDir: "/proj", fs })).toMatchObject({ ok: false, code: "not-found" })
    }
  })
})

describe("isInside / displayPath", () => {
  test("posix", () => {
    expect(isInside("/a/b", "/a/b", posix)).toBe(true)
    expect(isInside("/a/b", "/a/b/c", posix)).toBe(true)
    expect(isInside("/a/b", "/a/bc", posix)).toBe(false)
    expect(isInside("/a/b", "/a", posix)).toBe(false)
    expect(isInside("/a/b", "/a/b/..foo", posix)).toBe(true)
  })
  test("win32 is case-insensitive and drive-aware", () => {
    expect(isInside("C:\\Proj", "c:\\proj\\x", win32)).toBe(true)
    expect(isInside("C:\\Proj", "D:\\Proj\\x", win32)).toBe(false)
  })
  test("displayPath", () => {
    expect(displayPath("/a/b/c.txt", "/a/b", posix)).toBe("c.txt")
    expect(displayPath("/x/c.txt", "/a/b", posix)).toBe("/x/c.txt")
  })
})

/** Fake fs: `files` (absolute, as the path module writes them) exist; every probe is recorded. */
function fakeFs(files: Record<string, "file" | "dir">, caseless = false) {
  const norm = (p: string) => (caseless ? p.toLowerCase() : p)
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), { real: k, kind: v }]))
  const probes: string[] = []
  return {
    probes,
    fs: {
      realpathSync(p: string) {
        probes.push(p)
        const e = map.get(norm(p))
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
        return e.real
      },
      statSync(p: string) {
        const e = map.get(norm(p))
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
        return { isDirectory: () => e.kind === "dir" }
      },
    },
  }
}

describe("resolveTarget: Windows path rules (path.win32 injected)", () => {
  const files = {
    "C:\\proj": "dir",
    "C:\\proj\\docs\\a.md": "file",
    "C:\\Windows\\win.ini": "file",
    "D:\\other\\x.txt": "file",
    "\\\\attacker\\share\\x.md": "file",
    "\\\\nas\\team\\spec.md": "file",
    "\\\\nas\\team": "dir",
  } as const
  const base = (o: { allowOutsideProject?: boolean; roots?: string[] } = {}) => {
    const f = fakeFs(files, true)
    return { f, opts: { baseDir: "C:\\proj", path: win32, fs: f.fs, homeDir: "C:\\Users\\me", ...o } }
  }

  test.each([
    "docs\\a.md",
    "docs/a.md",
    "C:\\proj\\docs\\a.md",
    "c:/PROJ/docs/A.md",
    "file:///C:/proj/docs/a.md",
    ".\\docs\\..\\docs\\a.md",
  ])("inside: %s", (href) => {
    const { opts } = base()
    const r = resolveTarget(href, opts)
    expect(r.ok && r.path).toBe("C:\\proj\\docs\\a.md")
  })

  test.each([
    "..\\Windows\\win.ini",
    "../Windows/win.ini",
    "..%5CWindows%5Cwin.ini",
    "%2e%2e%2fWindows%2fwin.ini",
    "C:\\Windows\\win.ini",
    "C:/proj/../Windows/win.ini",
    "file:///C:/Windows/win.ini",
    "D:\\other\\x.txt",
  ])("outside, refused before any file system access: %s", (href) => {
    const { f, opts } = base()
    const r = resolveTarget(href, opts)
    expect(r).toMatchObject({ ok: false, code: "outside-project" })
    for (const p of f.probes) expect(p.toLowerCase().startsWith("c:\\proj")).toBe(true)
  })

  test.each([
    "\\\\attacker\\share\\x.md",
    "//attacker/share/x.md".replace(/^\/\//, "\\\\"),
    "/\\attacker\\share\\x.md",
    "\\/attacker/share/x.md",
    "file://attacker/share/x.md",
    "\\\\?\\UNC\\attacker\\share\\x.md",
    "\\\\.\\pipe\\x",
  ])("network/device path never stat'ed, even with allowOutsideProject (NTLM leak): %s", (href) => {
    for (const allowOutsideProject of [false, true]) {
      const { f, opts } = base({ allowOutsideProject })
      const r = resolveTarget(href, opts)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("outside-project")
      if (!r.ok && allowOutsideProject) expect(r.message).toContain("network or device path")
      expect(f.probes.some((p) => p.startsWith("\\\\") || p.startsWith("/"))).toBe(false)
    }
  })

  test("a share listed in roots is allowed", () => {
    const { opts } = base({ roots: ["\\\\nas\\team"] })
    const r = resolveTarget("\\\\nas\\team\\spec.md", opts)
    expect(r.ok && r.path).toBe("\\\\nas\\team\\spec.md")
  })

  test("allowOutsideProject allows local drives", () => {
    const { opts } = base({ allowOutsideProject: true })
    expect(resolveTarget("D:\\other\\x.txt", opts).ok).toBe(true)
    expect(resolveTarget("~\\..\\..\\Windows\\win.ini", opts).ok).toBe(true)
  })

  test("NUL bytes never reach the file system", () => {
    const { f, opts } = base()
    expect(resolveTarget("docs/a.md%00.txt", opts).ok).toBe(false)
    expect(f.probes.some((p) => p.includes("\u0000"))).toBe(false)
  })
})

describe("resolveTarget: POSIX lexical pre-check", () => {
  test("paths outside the roots are refused without probing the file system", () => {
    const f = fakeFs({ "/proj": "dir", "/proj/a.md": "file", "/etc/passwd": "file" })
    const opts = { baseDir: "/proj", path: posix, fs: f.fs, homeDir: "/home/me" }
    for (const href of [
      "../etc/passwd",
      "/etc/passwd",
      "%2e%2e/etc/passwd",
      "..%2Fetc%2Fpasswd",
      "~/x",
      "file:///etc/passwd",
      "a.md/../../etc/passwd",
    ]) {
      expect(resolveTarget(href, opts)).toMatchObject({ ok: false, code: "outside-project" })
    }
    expect(f.probes.every((p) => p === "/proj" || p.startsWith("/proj/"))).toBe(true)
    expect(resolveTarget("a.md", opts).ok).toBe(true)
  })

  test("a literal file named like an encoded traversal inside the project is found", () => {
    const f = fakeFs({ "/proj": "dir", "/proj/..%2Fsecret": "file" })
    const r = resolveTarget("..%2Fsecret", { baseDir: "/proj", path: posix, fs: f.fs })
    expect(r.ok && r.path).toBe("/proj/..%2Fsecret")
  })

  test("symlinked root: links written with the real path are inside", () => {
    const f = fakeFs({ "/data/proj": "dir", "/data/proj/a.md": "file" })
    const fs = { ...f.fs, realpathSync: (p: string) => f.fs.realpathSync(p.replace(/^\/home\/me\/proj/, "/data/proj")) }
    const r = resolveTarget("/data/proj/a.md", { baseDir: "/home/me/proj", path: posix, fs })
    expect(r.ok && r.path).toBe("/data/proj/a.md")
  })
})

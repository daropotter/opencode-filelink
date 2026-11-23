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

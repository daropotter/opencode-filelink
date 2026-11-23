import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { DEFAULTS, type FilelinkConfig } from "../src/config.js"
import { chooseAction, openLink } from "../src/core/opener.js"
import { fakeSpawner, tempTree } from "./helpers.js"

let project: ReturnType<typeof tempTree>
beforeAll(() => {
  project = tempTree({ "docs/report.md": "x", "src/main.go": "x", "dir/sub": null })
})
afterAll(() => project.cleanup())

const vscode = ["code", "-g", "{file}:{line}:{col}"] as const
const cfg = (o: Partial<FilelinkConfig> = {}): FilelinkConfig => ({ ...DEFAULTS, ...o })

describe("chooseAction", () => {
  test.each([
    // [config, hasLine, override, expected action, fellBack]
    [{}, false, undefined, "reveal", false],
    [{ action: "open" }, false, undefined, "open", false],
    [{}, true, undefined, "reveal", false],
    [{ editor: vscode }, true, undefined, "editor", false],
    [{ editor: vscode }, false, undefined, "reveal", false],
    [{ editor: vscode, lineAction: "open" }, true, undefined, "open", false],
    [{ action: "editor" }, false, undefined, "open", true],
    [{ action: "editor", editor: vscode }, false, undefined, "editor", false],
    [{ action: "open" }, true, "editor", "open", true],
    [{}, true, "open", "open", false],
    [{ lineAction: "editor" }, true, undefined, "reveal", true],
  ] as const)("%j line=%s override=%s → %s", (o, hasLine, override, expected, fellBack) => {
    expect(chooseAction(cfg(o as Partial<FilelinkConfig>), hasLine, override)).toEqual({ action: expected, fellBack })
  })
})

describe("openLink", () => {
  test("reveal on linux uses DBus first", async () => {
    const { spawner, calls } = fakeSpawner(() => ({ exit: 0 }))
    const r = await openLink({ href: "docs/report.md" }, { config: cfg(), baseDir: project.root, platform: "linux", exec: { spawner } })
    expect(r.ok).toBe(true)
    expect(r.action).toBe("reveal")
    expect(r.message).toBe(`Revealed ${join("docs", "report.md")} in the file manager`)
    expect(calls[0]?.cmd).toBe("busctl")
  })

  test("line link opens the editor at the line", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "src/main.go:12:3" },
      { config: cfg({ editor: vscode }), baseDir: project.root, platform: "darwin", exec: { spawner } },
    )
    expect(r.ok).toBe(true)
    expect(r.message).toBe(`Opened ${join("src", "main.go")}:12:3 in the editor`)
    expect(calls).toEqual([expect.objectContaining({ cmd: "code", args: ["-g", `${join(project.root, "src", "main.go")}:12:3`] })])
  })

  test("line link without editor falls back to action", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "src/main.go#L5" },
      { config: cfg({ action: "open" }), baseDir: project.root, platform: "darwin", exec: { spawner } },
    )
    expect(r.ok && r.action).toBe("open")
    expect(calls[0]).toMatchObject({ cmd: "open", args: [join(project.root, "src", "main.go")] })
  })

  test("explicit line overrides and explicit action", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "src/main.go:1:9", line: 40, action: "editor" },
      { config: cfg({ editor: vscode }), baseDir: project.root, platform: "linux", exec: { spawner } },
    )
    expect(r.ok).toBe(true)
    expect(calls[0]?.args).toEqual(["-g", `${join(project.root, "src", "main.go")}:40`])
  })

  test("action fallback is noted", async () => {
    const { spawner } = fakeSpawner()
    const r = await openLink(
      { href: "docs/report.md", action: "editor" },
      { config: cfg(), baseDir: project.root, platform: "darwin", exec: { spawner } },
    )
    expect(r.ok && r.action).toBe("reveal")
    expect(r.message).toContain("(no editor configured)")
  })

  test("WSL computes the Windows path via wslpath", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "docs/report.md" },
      {
        config: cfg(),
        baseDir: project.root,
        platform: "wsl",
        exec: { spawner },
        wslpath: async (p) => `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, "\\")}`,
      },
    )
    expect(r.ok).toBe(true)
    expect(calls[0]?.cmd).toBe("explorer.exe")
    expect(calls[0]?.args[0]).toStartWith("/select,\\\\wsl.localhost\\Ubuntu")
  })

  test("WSL without wslpath falls back to the computed path", async () => {
    const { spawner, calls } = fakeSpawner()
    await openLink(
      { href: "docs/report.md", action: "open" },
      {
        config: cfg(),
        baseDir: project.root,
        platform: "wsl",
        exec: { spawner },
        wslpath: async () => undefined,
        env: { WSL_DISTRO_NAME: "Arch" },
      },
    )
    expect(calls.map((c) => c.cmd)).toEqual(["wslview"])
  })

  test("missing file and outside project produce errors without spawning", async () => {
    const { spawner, calls } = fakeSpawner()
    const deps = { config: cfg(), baseDir: project.root, platform: "linux" as const, exec: { spawner } }
    const missing = await openLink({ href: "docs/nope.md" }, deps)
    expect(missing).toMatchObject({ ok: false, message: `File not found: ${join("docs", "nope.md")}` })
    const outside = await openLink({ href: "../" }, deps)
    expect(outside.ok).toBe(false)
    expect(outside.message).toContain("outside the project")
    expect(calls).toHaveLength(0)
  })

  test("extraRoots from config are honoured", async () => {
    const other = tempTree({ "x.txt": "x" })
    try {
      const { spawner } = fakeSpawner()
      const r = await openLink(
        { href: join(other.root, "x.txt") },
        { config: cfg({ extraRoots: [other.root] }), baseDir: project.root, platform: "darwin", exec: { spawner } },
      )
      expect(r.ok).toBe(true)
    } finally {
      other.cleanup()
    }
  })

  test("launch failure is reported", async () => {
    const { spawner } = fakeSpawner(() => "enoent")
    const r = await openLink(
      { href: "docs/report.md", action: "open" },
      { config: cfg(), baseDir: project.root, platform: "linux", exec: { spawner } },
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain("xdg-open: command not found")
  })

  test("unsafe Windows path yields a clear error", async () => {
    const r = await openLink(
      { href: "docs/report.md" },
      {
        config: cfg(),
        baseDir: project.root,
        platform: "win32",
        exec: { spawner: fakeSpawner().spawner },
        fs: { realpathSync: () => 'C:\\a"b', statSync: () => ({ isDirectory: () => false }) },
      },
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain("no suitable command")
  })

  test("never throws", async () => {
    const r = await openLink(
      { href: "docs/report.md" },
      {
        config: cfg(),
        baseDir: project.root,
        platform: "linux",
        exec: {
          spawner: () => {
            throw new Error("boom")
          },
        },
      },
    )
    expect(r.ok).toBe(false)
  })
})

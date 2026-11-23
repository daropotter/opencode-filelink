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
    expect(calls.map((c) => c.cmd)).toEqual(["explorer.exe"])
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

describe("openLink: Windows editor resolution", () => {
  const VSCODE = "C:\\Program Files\\Microsoft VS Code"
  const winEnv = { PATH: `C:\\Windows\\system32;${VSCODE}\\bin`, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" }
  const isFileOf = (files: string[]) => (p: string) => files.some((f) => f.toLowerCase() === p.toLowerCase())

  test("explorer.exe is spawned by absolute path from %SystemRoot%", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "docs/report.md" },
      { config: cfg(), baseDir: project.root, platform: "win32", exec: { spawner, refuseBatchFiles: true }, env: winEnv },
    )
    expect(r.ok).toBe(true)
    expect(calls.map((c) => c.cmd)).toEqual(["C:\\Windows\\explorer.exe"])
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true)
  })

  test("code.cmd shim → Code.exe with cli.js, no shell, no batch file", async () => {
    const { spawner, calls } = fakeSpawner()
    const files = [`${VSCODE}\\bin\\code.cmd`, `${VSCODE}\\Code.exe`, `${VSCODE}\\resources\\app\\out\\cli.js`]
    const r = await openLink(
      { href: "src/main.go:7" },
      {
        config: cfg({ editor: ["code", "-g", "{file}:{line}:{col}"] }),
        baseDir: project.root,
        platform: "win32",
        exec: { spawner, refuseBatchFiles: true },
        env: winEnv,
        isFile: isFileOf(files),
      },
    )
    expect(r).toMatchObject({ ok: true, action: "editor" })
    expect(r.warning).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toBe(`${VSCODE}\\Code.exe`)
    expect(calls[0]?.args).toEqual([`${VSCODE}\\resources\\app\\out\\cli.js`, "-g", `${join(project.root, "src", "main.go")}:7`])
    expect(calls[0]?.options).toMatchObject({ shell: false })
    expect((calls[0]?.options.env as Record<string, string> | undefined)?.ELECTRON_RUN_AS_NODE).toBe("1")
  })

  test("an unmappable .cmd editor falls back to the default action with a warning", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "src/main.go:7" },
      {
        config: cfg({ editor: ["myedit", "{file}"] }),
        baseDir: project.root,
        platform: "win32",
        exec: { spawner, refuseBatchFiles: true },
        env: { ...winEnv, PATH: "C:\\tools" },
        isFile: isFileOf(["C:\\tools\\myedit.cmd"]),
      },
    )
    expect(r).toMatchObject({ ok: true, action: "reveal" })
    expect(r.message).toContain("editor unavailable")
    expect(r.warning).toContain("batch file")
    expect(calls.map((c) => c.cmd)).toEqual(["C:\\Windows\\explorer.exe"])
    expect(calls.some((c) => /\.(cmd|bat)$/i.test(c.cmd))).toBe(false)
  })

  test("editor not on PATH: fallback, configured action is used", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await openLink(
      { href: "src/main.go", action: "editor" },
      {
        config: cfg({ action: "open", editor: ["zed", "{file}"] }),
        baseDir: project.root,
        platform: "win32",
        exec: { spawner },
        env: winEnv,
        isFile: () => false,
      },
    )
    expect(r).toMatchObject({ ok: true, action: "open" })
    expect(r.warning).toContain("not found on PATH")
    expect(calls).toHaveLength(1)
  })
})

describe("openLink: executable targets are revealed, not opened", () => {
  let exe: ReturnType<typeof tempTree>
  beforeAll(() => {
    exe = tempTree({ "run.BAT": "x", "setup.desktop": "x", "Evil.app/Contents": null, "tool.ps1": "x", "notes.md": "x" })
  })
  afterAll(() => exe.cleanup())

  test.each([
    ["win32", "run.BAT"],
    ["win32", "tool.ps1"],
    ["wsl", "run.BAT"],
    ["linux", "setup.desktop"],
    ["darwin", "Evil.app"],
  ] as const)("%s: %s", async (platform, href) => {
    const { spawner } = fakeSpawner()
    const r = await openLink(
      { href, action: "open" },
      {
        config: cfg(),
        baseDir: exe.root,
        platform,
        exec: { spawner },
        env: { SystemRoot: "C:\\Windows" },
        wslpath: async () => "C:\\x",
      },
    )
    expect(r).toMatchObject({ ok: true, action: "reveal" })
    expect(r.warning).toContain("executable")
  })

  test("documents are still opened", async () => {
    const { spawner } = fakeSpawner()
    const r = await openLink(
      { href: "notes.md", action: "open" },
      { config: cfg(), baseDir: exe.root, platform: "linux", exec: { spawner } },
    )
    expect(r).toMatchObject({ ok: true, action: "open" })
    expect(r.warning).toBeUndefined()
  })
})

describe("openLink: no graphical session", () => {
  test("xdg-open failure explains missing DISPLAY / WAYLAND_DISPLAY", async () => {
    const { spawner } = fakeSpawner(() => ({ exit: 3 }))
    const r = await openLink(
      { href: "docs/report.md", action: "open" },
      { config: cfg(), baseDir: project.root, platform: "linux", exec: { spawner }, env: {} },
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain("xdg-open: exited with code 3")
    expect(r.message).toContain("no graphical session")
  })

  test("no hint when a display is set", async () => {
    const { spawner } = fakeSpawner(() => ({ exit: 4 }))
    const r = await openLink(
      { href: "docs/report.md", action: "open" },
      { config: cfg(), baseDir: project.root, platform: "linux", exec: { spawner }, env: { WAYLAND_DISPLAY: "wayland-0" } },
    )
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain("no graphical session")
  })
})

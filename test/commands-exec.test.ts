import { describe, expect, test } from "bun:test"
import { buildCommands, isSafeWindowsPath, toFileUri, wslToWindowsPath } from "../src/core/commands.js"
import { createRecordingSpawner, runCommands } from "../src/core/exec.js"
import { fakeSpawner } from "./helpers.js"

const file = { path: "/home/u/proj/docs/my report,'x'.md", isDirectory: false }

describe("toFileUri", () => {
  test("encodes everything outside unreserved and '/'", () => {
    expect(toFileUri("/home/u/a b/ść,'(x)!*.md")).toBe("file:///home/u/a%20b/%C5%9B%C4%87%2C%27%28x%29%21%2A.md")
  })
})

describe("wslToWindowsPath", () => {
  test("/mnt/<drive>", () => {
    expect(wslToWindowsPath("/mnt/c/Users/me/a.txt", "Ubuntu")).toBe("C:\\Users\\me\\a.txt")
    expect(wslToWindowsPath("/mnt/d", "Ubuntu")).toBe("D:\\")
  })
  test("Linux-side file", () => {
    expect(wslToWindowsPath("/home/me/a.txt", "Debian")).toBe("\\\\wsl.localhost\\Debian\\home\\me\\a.txt")
    expect(wslToWindowsPath("/home/me/a.txt", undefined)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt")
  })
})

describe("isSafeWindowsPath", () => {
  test.each([
    ["C:\\a\\b.txt", true],
    ["\\\\srv\\share\\a b.txt", true],
    ["C:\\a\\100% & ^x.txt", true],
    ['C:\\a\\"x.txt', false],
    ["C:\\a\\x|y", false],
    ["C:\\a\\x\ny", false],
  ] as const)("%s", (p, ok) => {
    expect(isSafeWindowsPath(p)).toBe(ok)
  })
})

describe("buildCommands: linux", () => {
  test("reveal: busctl → gdbus → dbus-send → xdg-open parent → gio", () => {
    const cmds = buildCommands({ action: "reveal", platform: "linux", ...file })
    expect(cmds.map((c) => c.cmd)).toEqual(["busctl", "gdbus", "dbus-send", "xdg-open", "gio"])
    const uri = "file:///home/u/proj/docs/my%20report%2C%27x%27.md"
    expect(cmds[0]?.args).toEqual([
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
    ])
    expect(cmds[0]?.wait).toBe(true)
    expect(cmds[1]?.args).toContain(`['${uri}']`)
    expect(cmds[2]?.args).toContain(`array:string:${uri}`)
    expect(cmds[2]?.args).toContain("--print-reply")
    expect(cmds[3]).toEqual({ cmd: "xdg-open", args: ["/home/u/proj/docs"] })
    expect(cmds[4]).toEqual({ cmd: "gio", args: ["open", "/home/u/proj/docs"] })
  })
  test("reveal a directory selects it in its parent", () => {
    const cmds = buildCommands({ action: "reveal", platform: "linux", path: "/p/src", isDirectory: true })
    expect(cmds[0]?.args).toContain("file:///p/src")
    expect(cmds[3]).toEqual({ cmd: "xdg-open", args: ["/p"] })
  })
  test("open", () => {
    expect(buildCommands({ action: "open", platform: "linux", ...file })).toEqual([
      { cmd: "xdg-open", args: [file.path] },
      { cmd: "gio", args: ["open", file.path] },
    ])
  })
  test("editor", () => {
    expect(
      buildCommands({ action: "editor", platform: "linux", ...file, line: 3, col: 1, editor: ["code", "-g", "{file}:{line}:{col}"] }),
    ).toEqual([{ cmd: "code", args: ["-g", `${file.path}:3:1`] }])
  })
  test("editor without template yields nothing", () => {
    expect(buildCommands({ action: "editor", platform: "linux", ...file })).toEqual([])
    expect(buildCommands({ action: "editor", platform: "linux", ...file, editor: [] })).toEqual([])
  })
})

describe("buildCommands: darwin", () => {
  test("reveal / open / editor", () => {
    expect(buildCommands({ action: "reveal", platform: "darwin", ...file })).toEqual([{ cmd: "open", args: ["-R", file.path] }])
    expect(buildCommands({ action: "open", platform: "darwin", ...file })).toEqual([{ cmd: "open", args: [file.path] }])
    expect(buildCommands({ action: "editor", platform: "darwin", ...file, line: 7, editor: ["zed", "{file}:{line}:{col}"] })).toEqual([
      { cmd: "zed", args: [`${file.path}:7`] },
    ])
  })
})

describe("buildCommands: win32", () => {
  const w = { path: "C:\\Users\\me\\My Docs\\a & b%PATH%.txt", isDirectory: false }
  test("reveal uses explorer /select with verbatim quoting", () => {
    expect(buildCommands({ action: "reveal", platform: "win32", ...w })).toEqual([
      { cmd: "explorer.exe", args: [`/select,"${w.path}"`], verbatim: true },
    ])
  })
  test("open uses explorer with a quoted path, never cmd /c start", () => {
    const cmds = buildCommands({ action: "open", platform: "win32", ...w })
    expect(cmds).toEqual([{ cmd: "explorer.exe", args: [`"${w.path}"`], verbatim: true }])
    expect(cmds.some((c) => c.cmd.toLowerCase().includes("cmd"))).toBe(false)
  })
  test("paths with quotes are refused", () => {
    expect(buildCommands({ action: "reveal", platform: "win32", path: 'C:\\a"b', isDirectory: false })).toEqual([])
  })
  test("editor falls back to the .cmd shim", () => {
    expect(buildCommands({ action: "editor", platform: "win32", ...w, line: 2, editor: ["code", "-g", "{file}:{line}:{col}"] })).toEqual([
      { cmd: "code", args: ["-g", `${w.path}:2`] },
      { cmd: "code.cmd", args: ["-g", `${w.path}:2`] },
    ])
    expect(buildCommands({ action: "editor", platform: "win32", ...w, editor: ["C:\\zed\\zed.exe", "{file}"] })).toEqual([
      { cmd: "C:\\zed\\zed.exe", args: [w.path] },
    ])
  })
})

describe("buildCommands: wsl", () => {
  const l = { path: "/home/me/proj/a b.md", isDirectory: false, winPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\a b.md" }
  test("reveal uses explorer.exe /select with the Windows path", () => {
    expect(buildCommands({ action: "reveal", platform: "wsl", ...l })).toEqual([{ cmd: "explorer.exe", args: [`/select,${l.winPath}`] }])
  })
  test("open prefers wslview then explorer.exe", () => {
    expect(buildCommands({ action: "open", platform: "wsl", ...l })).toEqual([
      { cmd: "wslview", args: [l.path] },
      { cmd: "explorer.exe", args: [l.winPath] },
    ])
  })
  test("falls back to computed Windows path", () => {
    expect(buildCommands({ action: "reveal", platform: "wsl", path: "/mnt/c/x.txt", isDirectory: false })).toEqual([
      { cmd: "explorer.exe", args: ["/select,C:\\x.txt"] },
    ])
  })
  test("editor runs the Linux-side command", () => {
    expect(buildCommands({ action: "editor", platform: "wsl", ...l, line: 1, editor: ["code", "-g", "{file}:{line}:{col}"] })).toEqual([
      { cmd: "code", args: ["-g", `${l.path}:1`] },
    ])
  })
})

describe("runCommands", () => {
  test("first command that spawns wins; options are safe", async () => {
    const { spawner, calls } = fakeSpawner()
    const r = await runCommands([{ cmd: "xdg-open", args: ["/x"] }], { spawner })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({ shell: false, detached: true, stdio: "ignore" })
    expect(calls[0]?.options.windowsVerbatimArguments).toBeUndefined()
  })

  test("verbatim flag is passed through", async () => {
    const { spawner, calls } = fakeSpawner()
    await runCommands([{ cmd: "explorer.exe", args: ['"C:\\x"'], verbatim: true }], { spawner })
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true)
  })

  test("ENOENT falls through the chain", async () => {
    const { spawner, calls } = fakeSpawner((cmd) => (cmd === "gio" ? "spawn" : "enoent"))
    const r = await runCommands(
      [
        { cmd: "xdg-open", args: ["/x"] },
        { cmd: "gio", args: ["open", "/x"] },
      ],
      { spawner },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.cmd).toBe("gio")
    expect(calls.map((c) => c.cmd)).toEqual(["xdg-open", "gio"])
    expect(r.attempts[0]?.error).toBe("xdg-open: command not found")
  })

  test("full Linux reveal chain: DBus failures fall back to xdg-open", async () => {
    const { spawner, calls } = fakeSpawner((cmd) => {
      if (cmd === "busctl") return "enoent"
      if (cmd === "gdbus") return { exit: 1 }
      if (cmd === "dbus-send") return "eacces"
      return "spawn"
    })
    const cmds = buildCommands({ action: "reveal", platform: "linux", path: "/p/a.md", isDirectory: false })
    const r = await runCommands(cmds, { spawner })
    expect(r.ok && r.command.cmd).toBe("xdg-open")
    expect(calls.map((c) => c.cmd)).toEqual(["busctl", "gdbus", "dbus-send", "xdg-open"])
    expect(r.attempts.map((a) => a.error)).toEqual([
      "busctl: command not found",
      "gdbus: exited with code 1",
      "dbus-send: permission denied",
      undefined,
    ])
  })

  test("wait commands succeed on exit 0", async () => {
    const { spawner, calls } = fakeSpawner(() => ({ exit: 0 }))
    const r = await runCommands(
      [
        { cmd: "busctl", args: [], wait: true },
        { cmd: "xdg-open", args: [] },
      ],
      { spawner },
    )
    expect(r.ok && r.command.cmd).toBe("busctl")
    expect(calls).toHaveLength(1)
  })

  test("wait command that hangs is assumed to have worked after the timeout", async () => {
    const { spawner } = fakeSpawner(() => "silent")
    const r = await runCommands([{ cmd: "busctl", args: [], wait: true }], { spawner, waitTimeoutMs: 10 })
    expect(r.ok).toBe(true)
  })

  test("no spawn event: assume started after the spawn timeout", async () => {
    const { spawner } = fakeSpawner(() => "silent")
    const r = await runCommands([{ cmd: "x", args: [] }], { spawner, spawnTimeoutMs: 10 })
    expect(r.ok).toBe(true)
  })

  test("synchronous spawn errors fall through", async () => {
    const { spawner } = fakeSpawner((cmd) => (cmd === "code" ? "throw" : "spawn"))
    const r = await runCommands(
      [
        { cmd: "code", args: [] },
        { cmd: "code.cmd", args: [] },
      ],
      { spawner },
    )
    expect(r.ok && r.command.cmd).toBe("code.cmd")
    expect(r.attempts[0]?.error).toContain("EINVAL")
  })

  test("all failing reports every attempt", async () => {
    const { spawner } = fakeSpawner(() => "enoent")
    const r = await runCommands(
      [
        { cmd: "a", args: [] },
        { cmd: "b", args: [] },
      ],
      { spawner },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("Could not launch any of: a: command not found; b: command not found")
  })

  test("empty chain", async () => {
    const r = await runCommands([], { spawner: fakeSpawner().spawner })
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("No command") })
  })

  test("recording spawner", async () => {
    const seen: string[][] = []
    const spawner = createRecordingSpawner((cmd, args) => seen.push([cmd, ...args]))
    const r = await runCommands([{ cmd: "busctl", args: ["x"], wait: true }], { spawner })
    expect(r.ok).toBe(true)
    expect(seen).toEqual([["busctl", "x"]])
  })
})

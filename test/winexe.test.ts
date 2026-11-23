import { describe, expect, test } from "bun:test"
import { explorerPath, isBatchFile, resolveWindowsCommand, resolveWindowsCommands } from "../src/core/winexe.js"

/** Case-insensitive fake Windows file system that records every probe. */
function fakeWinFs(files: readonly string[]) {
  const set = new Set(files.map((f) => f.toLowerCase()))
  const probes: string[] = []
  return {
    probes,
    isFile: (p: string) => {
      probes.push(p)
      return set.has(p.toLowerCase())
    },
  }
}

const VSCODE = "C:\\Program Files\\Microsoft VS Code"
const env = { PATH: `C:\\Windows\\system32;${VSCODE}\\bin;C:\\tools`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" }

describe("isBatchFile", () => {
  test.each([
    ["code.cmd", true],
    ["C:\\x\\RUN.BAT", true],
    ["evil.cmd.", true],
    ["evil.bat .", true],
    ["code.exe", false],
    ["code", false],
    ["cmd.exe", false],
    ["notes.cmdx", false],
  ] as const)("%s", (p, b) => expect(isBatchFile(p)).toBe(b))
})

describe("resolveWindowsCommand", () => {
  test("bare name resolves to an absolute .exe on PATH", () => {
    const fs = fakeWinFs(["C:\\tools\\zed.exe"])
    expect(resolveWindowsCommand("zed", { env, isFile: fs.isFile })).toEqual({ ok: true, cmd: "C:\\tools\\zed.exe", prefixArgs: [] })
  })

  test("the current directory and relative PATH entries are never searched (binary planting)", () => {
    const fs = fakeWinFs(["code.exe", ".\\code.exe", "C:\\tools\\code.exe"])
    const r = resolveWindowsCommand("code", { env: { PATH: `.;;bin;\\rooted;"C:\\tools"`, PATHEXT: ".EXE" }, isFile: fs.isFile })
    expect(r).toEqual({ ok: true, cmd: "C:\\tools\\code.exe", prefixArgs: [] })
    for (const p of fs.probes) expect(/^[A-Za-z]:\\/.test(p)).toBe(true)
  })

  test("VS Code's code.cmd shim is mapped to Code.exe + cli.js (as the shim does)", () => {
    const fs = fakeWinFs([`${VSCODE}\\bin\\code.cmd`, `${VSCODE}\\Code.exe`, `${VSCODE}\\resources\\app\\out\\cli.js`])
    expect(resolveWindowsCommand("code", { env, isFile: fs.isFile })).toEqual({
      ok: true,
      cmd: `${VSCODE}\\Code.exe`,
      prefixArgs: [`${VSCODE}\\resources\\app\\out\\cli.js`],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    })
  })

  test("shim without a recognised cli.js layout runs the Electron exe directly", () => {
    const fs = fakeWinFs([`${VSCODE}\\bin\\code.cmd`, `${VSCODE}\\Code.exe`])
    expect(resolveWindowsCommand("code", { env, isFile: fs.isFile })).toEqual({ ok: true, cmd: `${VSCODE}\\Code.exe`, prefixArgs: [] })
  })

  test("other editors' shims (cursor, codium)", () => {
    const fs = fakeWinFs(["C:\\Cursor\\bin\\cursor.cmd", "C:\\Cursor\\Cursor.exe"])
    const r = resolveWindowsCommand("cursor", { env: { PATH: "C:\\Cursor\\bin" }, isFile: fs.isFile })
    expect(r).toMatchObject({ ok: true, cmd: "C:\\Cursor\\Cursor.exe" })
  })

  test("unknown batch files are refused, never run", () => {
    const fs = fakeWinFs(["C:\\tools\\myedit.cmd"])
    const r = resolveWindowsCommand("myedit", { env, isFile: fs.isFile })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("batch file")
      expect(r.reason).toContain(".exe")
    }
    const abs = resolveWindowsCommand("C:\\tools\\myedit.cmd", { env, isFile: fs.isFile })
    expect(abs.ok).toBe(false)
  })

  test("a shim whose exe is missing is refused", () => {
    const fs = fakeWinFs([`${VSCODE}\\bin\\code.cmd`])
    expect(resolveWindowsCommand("code", { env, isFile: fs.isFile }).ok).toBe(false)
  })

  test(".exe found before a .cmd of the same name (PATHEXT order)", () => {
    const fs = fakeWinFs(["C:\\tools\\ed.cmd", "C:\\tools\\ed.exe"])
    expect(resolveWindowsCommand("ed", { env, isFile: fs.isFile })).toMatchObject({ ok: true, cmd: "C:\\tools\\ed.exe" })
  })

  test("absolute paths are checked; relative paths with separators are refused", () => {
    const fs = fakeWinFs(["D:\\apps\\zed.exe"])
    expect(resolveWindowsCommand("D:\\apps\\zed.exe", { env, isFile: fs.isFile })).toMatchObject({ ok: true, cmd: "D:\\apps\\zed.exe" })
    expect(resolveWindowsCommand("D:\\apps\\zed", { env, isFile: fs.isFile })).toMatchObject({ ok: true, cmd: "D:\\apps\\zed.exe" })
    expect(resolveWindowsCommand("apps\\zed.exe", { env, isFile: fs.isFile }).ok).toBe(false)
    expect(resolveWindowsCommand("\\apps\\zed.exe", { env, isFile: fs.isFile }).ok).toBe(false)
  })

  test("not found", () => {
    const r = resolveWindowsCommand("nope", { env, isFile: fakeWinFs([]).isFile })
    expect(r).toEqual({ ok: false, reason: '"nope" was not found on PATH' })
  })

  test("env lookup is case-insensitive (Path / PATHEXT)", () => {
    const fs = fakeWinFs(["C:\\tools\\zed.exe"])
    expect(resolveWindowsCommand("zed", { env: { Path: "C:\\tools" }, isFile: fs.isFile })).toMatchObject({ ok: true })
  })
})

describe("explorerPath / resolveWindowsCommands", () => {
  test("explorer.exe comes from %SystemRoot%, never the current directory", () => {
    expect(explorerPath({ SystemRoot: "D:\\WINDOWS" })).toBe("D:\\WINDOWS\\explorer.exe")
    expect(explorerPath({ windir: "E:\\Win" })).toBe("E:\\Win\\explorer.exe")
    expect(explorerPath({})).toBe("C:\\Windows\\explorer.exe")
    expect(explorerPath({ SystemRoot: "relative" })).toBe("C:\\Windows\\explorer.exe")
  })

  test("maps a chain; unresolvable commands are dropped with reasons", () => {
    const fs = fakeWinFs([`${VSCODE}\\bin\\code.cmd`, `${VSCODE}\\Code.exe`])
    const r = resolveWindowsCommands(
      [
        { cmd: "explorer.exe", args: ['/select,"C:\\a.txt"'], verbatim: true },
        { cmd: "code", args: ["-g", "C:\\a & b.txt:3"] },
        { cmd: "missing", args: [] },
      ],
      { env: { ...env, SystemRoot: "C:\\Windows" }, isFile: fs.isFile },
    )
    expect(r.commands).toEqual([
      { cmd: "C:\\Windows\\explorer.exe", args: ['/select,"C:\\a.txt"'], verbatim: true },
      { cmd: `${VSCODE}\\Code.exe`, args: ["-g", "C:\\a & b.txt:3"] },
    ])
    expect(r.errors).toEqual(['"missing" was not found on PATH'])
  })
})

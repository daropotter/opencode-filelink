import { describe, expect, test } from "bun:test"
import { EDITOR_PRESETS, editorFromEnv, isTerminalEditor, parseEditorOption, renderEditorArgs, tokenize } from "../src/core/editor.js"
import { detectPlatform } from "../src/core/platform.js"

describe("detectPlatform", () => {
  const noProc = () => {
    throw new Error("ENOENT")
  }
  test("darwin / win32", () => {
    expect(detectPlatform({ platform: "darwin", env: {} })).toBe("darwin")
    expect(detectPlatform({ platform: "win32", env: {} })).toBe("win32")
  })
  test("plain linux", () => {
    expect(detectPlatform({ platform: "linux", env: {}, readFile: () => "Linux version 6.8.0-generic (gcc)" })).toBe("linux")
    expect(detectPlatform({ platform: "linux", env: {}, readFile: noProc })).toBe("linux")
  })
  test("WSL via env", () => {
    expect(detectPlatform({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, readFile: noProc })).toBe("wsl")
    expect(detectPlatform({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" }, readFile: noProc })).toBe("wsl")
  })
  test("WSL via /proc/version", () => {
    expect(detectPlatform({ platform: "linux", env: {}, readFile: () => "Linux version 5.15.153.1-microsoft-standard-WSL2" })).toBe("wsl")
  })
  test("other unixes behave like linux", () => {
    expect(detectPlatform({ platform: "freebsd", env: {} })).toBe("linux")
  })
})

describe("tokenize", () => {
  test.each([
    ["code -g {file}:{line}:{col}", ["code", "-g", "{file}:{line}:{col}"]],
    ['  "C:\\Program Files\\Code\\code.exe"  -g {file}', ["C:\\Program Files\\Code\\code.exe", "-g", "{file}"]],
    ["open -a 'Visual Studio Code' --args -g {file}", ["open", "-a", "Visual Studio Code", "--args", "-g", "{file}"]],
    ['say "a \\"b\\""', ["say", 'a "b"']],
    ["a\\ b c", ["a b", "c"]],
    ["x ''", ["x", ""]],
    ["", []],
  ] as const)("%s", (input, expected) => {
    expect(tokenize(input)).toEqual([...expected])
  })
  test("does not expand shell syntax", () => {
    expect(tokenize("code $(rm -rf ~) ; echo `x` | y && z")).toEqual(["code", "$(rm", "-rf", "~)", ";", "echo", "`x`", "|", "y", "&&", "z"])
  })
  test("unterminated quote throws", () => {
    expect(() => tokenize('code "abc')).toThrow(/Unterminated/)
  })
})

describe("parseEditorOption", () => {
  test("presets", () => {
    expect(parseEditorOption("vscode")).toEqual(EDITOR_PRESETS.vscode as string[])
    expect(parseEditorOption("Zed")).toEqual(["zed", "{file}:{line}:{col}"])
    expect(parseEditorOption("idea")).toEqual(["idea", "--line", "{line}", "--column", "{col}", "{file}"])
  })
  test("template string", () => {
    expect(parseEditorOption("code -g {file}:{line}:{col}")).toEqual(["code", "-g", "{file}:{line}:{col}"])
  })
  test("array", () => {
    expect(parseEditorOption(["my editor", "--goto", "{file}"])).toEqual(["my editor", "--goto", "{file}"])
  })
  test("appends {file} when missing", () => {
    expect(parseEditorOption("gedit")).toEqual(["gedit", "{file}"])
  })
  test("rejects terminal editors and empty commands", () => {
    expect(() => parseEditorOption("nvim +{line} {file}")).toThrow(/terminal/)
    expect(() => parseEditorOption("emacs -nw {file}")).toThrow(/terminal/)
    expect(() => parseEditorOption("")).toThrow(/empty/)
    expect(() => parseEditorOption([])).toThrow(/empty/)
  })
  test("terminal editor inside a terminal window is fine", () => {
    expect(parseEditorOption("kitty -e nvim +{line} {file}")).toEqual(["kitty", "-e", "nvim", "+{line}", "{file}"])
  })
  test("isTerminalEditor handles paths and extensions", () => {
    expect(isTerminalEditor(["/usr/bin/vim"])).toBe(true)
    expect(isTerminalEditor(["C:\\bin\\nvim.exe"])).toBe(true)
    expect(isTerminalEditor(["emacs"])).toBe(false)
    expect(isTerminalEditor([])).toBe(false)
  })
})

describe("editorFromEnv", () => {
  test("VISUAL wins over EDITOR", () => {
    expect(editorFromEnv({ VISUAL: "code --wait", EDITOR: "subl" })).toEqual(["code", "-g", "{file}:{line}:{col}"])
  })
  test("known editor keeps its path", () => {
    expect(editorFromEnv({ EDITOR: "/opt/bin/subl -w" })).toEqual(["/opt/bin/subl", "{file}:{line}:{col}"])
  })
  test("unknown GUI editor gets the file appended and --wait removed", () => {
    expect(editorFromEnv({ EDITOR: "gedit --wait" })).toEqual(["gedit", "{file}"])
  })
  test("terminal editors are skipped", () => {
    expect(editorFromEnv({ VISUAL: "nvim", EDITOR: "zed" })).toEqual(["zed", "{file}:{line}:{col}"])
    expect(editorFromEnv({ EDITOR: "vim" })).toBeUndefined()
    expect(editorFromEnv({})).toBeUndefined()
    expect(editorFromEnv({ EDITOR: 'bad "quote' })).toBeUndefined()
  })
})

describe("renderEditorArgs", () => {
  const vars = { file: "/p/a b.ts", dir: "/p" }
  test("line and col", () => {
    expect(renderEditorArgs(["code", "-g", "{file}:{line}:{col}"], { ...vars, line: 4, col: 2 })).toEqual(["code", "-g", "/p/a b.ts:4:2"])
  })
  test("line without col drops :{col}", () => {
    expect(renderEditorArgs(["code", "-g", "{file}:{line}:{col}"], { ...vars, line: 4 })).toEqual(["code", "-g", "/p/a b.ts:4"])
  })
  test("no line drops :{line}:{col}", () => {
    expect(renderEditorArgs(["code", "-g", "{file}:{line}:{col}"], vars)).toEqual(["code", "-g", "/p/a b.ts"])
  })
  test("stand-alone {line} drops its flag", () => {
    expect(renderEditorArgs(["idea", "--line", "{line}", "--column", "{col}", "{file}"], vars)).toEqual(["idea", "/p/a b.ts"])
    expect(renderEditorArgs(["idea", "--line", "{line}", "--column", "{col}", "{file}"], { ...vars, line: 9 })).toEqual([
      "idea",
      "--line",
      "9",
      "/p/a b.ts",
    ])
    expect(renderEditorArgs(["kitty", "-e", "nvim", "+{line}", "{file}"], vars)).toEqual(["kitty", "-e", "nvim", "/p/a b.ts"])
  })
  test("{dir}", () => {
    expect(renderEditorArgs(["x", "--cwd", "{dir}", "{file}"], vars)).toEqual(["x", "--cwd", "/p", "/p/a b.ts"])
  })
  test("placeholder-like text in file names is not substituted again", () => {
    expect(renderEditorArgs(["x", "{file}:{line}"], { file: "/p/{line}.txt", dir: "/p", line: 3 })).toEqual(["x", "/p/{line}.txt:3"])
  })
  test("shell metacharacters stay inside one argument", () => {
    const file = "/p/$(touch pwned); rm -rf ~ `x`.md"
    expect(renderEditorArgs(["code", "{file}"], { file, dir: "/p" })).toEqual(["code", file])
  })
})

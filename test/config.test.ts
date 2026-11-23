import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  configFileCandidates,
  DEFAULTS,
  findPluginOptions,
  loadConfig,
  mergeOptions,
  PACKAGE_NAME,
  parseJsonc,
  specMatchesPackage,
  stripJsonc,
  validateOptions,
} from "../src/config.js"
import { tempTree } from "./helpers.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function tree(files: Record<string, string | null>) {
  const t = tempTree(files)
  cleanups.push(t.cleanup)
  return t.root
}

describe("JSONC", () => {
  test("strips comments and trailing commas but not string contents", () => {
    const text = `{
      // line comment
      "a": "http://x.y/z", /* block
      comment */ "b": "/* not a comment */",
      "c": "// nor this",
      "d": [1, 2, ],
      "e": "trailing ,}",
      "f": "esc \\" // still string",
    }`
    expect(parseJsonc(text)).toEqual({
      a: "http://x.y/z",
      b: "/* not a comment */",
      c: "// nor this",
      d: [1, 2],
      e: "trailing ,}",
      f: 'esc " // still string',
    })
  })
  test("BOM and unterminated block comment", () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 })
    expect(stripJsonc('{"a":1} /* open')).toBe('{"a":1}  ')
  })
})

describe("validateOptions", () => {
  test("defaults", () => {
    const { config, warnings } = validateOptions({})
    expect(config).toEqual(DEFAULTS)
    expect(warnings).toEqual([])
  })

  test("valid values", () => {
    const { config, warnings } = validateOptions(
      {
        action: "open",
        lineAction: "reveal",
        editor: "code -g {file}:{line}:{col}",
        allowOutsideProject: true,
        extraRoots: ["/abs", "rel/dir", "~/x"],
        intercept: false,
        toast: false,
        keybind: "<leader>l",
        bridge: { enabled: false, port: 47777 },
        linkRewrite: "instruct",
        tools: false,
      },
      { projectDir: "/proj", homeDir: "/home/u" },
    )
    expect(warnings).toEqual([])
    expect(config).toEqual({
      action: "open",
      lineAction: "reveal",
      editor: ["code", "-g", "{file}:{line}:{col}"],
      editorFromEnv: false,
      allowOutsideProject: true,
      extraRoots: [join("/abs"), join("/proj", "rel/dir"), join("/home/u", "x")].map((p) => require("node:path").resolve(p)),
      intercept: false,
      toast: false,
      keybind: "<leader>l",
      bridge: { enabled: false, port: 47777 },
      linkRewrite: "instruct",
      tools: false,
    })
  })

  test("bad values are ignored with warnings", () => {
    const { config, warnings } = validateOptions({
      action: "explode",
      lineAction: 3,
      editor: 42,
      allowOutsideProject: "yes",
      extraRoots: "nope",
      keybind: "",
      bridge: { enabled: "x", port: 70000, host: "0.0.0.0" },
      linkRewrite: "stream",
      tools: 1,
      mystery: true,
    })
    expect(config).toEqual(DEFAULTS)
    expect(warnings).toHaveLength(12)
    expect(warnings.join("\n")).toContain('ignoring invalid "action"')
    expect(warnings.join("\n")).toContain('unknown option "mystery"')
    expect(warnings.join("\n")).toContain('unknown option "bridge.host"')
    expect(warnings.join("\n")).toContain('"bridge.port"')
  })

  test("terminal editor is rejected with a hint", () => {
    const { config, warnings } = validateOptions({ editor: "vim +{line} {file}" })
    expect(config.editor).toBeUndefined()
    expect(warnings[0]).toContain("kitty -e")
  })

  test("editor presets and arrays", () => {
    expect(validateOptions({ editor: "cursor" }).config.editor).toEqual(["cursor", "-g", "{file}:{line}:{col}"])
    expect(validateOptions({ editor: ["x", "{file}"] }).config.editor).toEqual(["x", "{file}"])
    expect(validateOptions({ editor: ["x", 1] }).warnings).toHaveLength(1)
  })

  test("$VISUAL/$EDITOR fallback only when enabled", () => {
    const env = { EDITOR: "code" }
    expect(validateOptions({}, { env }).config.editor).toBeUndefined()
    expect(validateOptions({ editorFromEnv: true }, { env }).config.editor).toEqual(["code", "-g", "{file}:{line}:{col}"])
    expect(validateOptions({ editorFromEnv: true, editor: "zed" }, { env }).config.editor).toEqual(["zed", "{file}:{line}:{col}"])
  })

  test("bridge shorthand and relative extraRoots without project", () => {
    expect(validateOptions({ bridge: false }).config.bridge).toEqual({ enabled: false, port: 0 })
    const r = validateOptions({ extraRoots: ["rel"] })
    expect(r.config.extraRoots).toEqual([])
    expect(r.warnings[0]).toContain("relative extraRoots")
  })

  test("non-object options", () => {
    expect(validateOptions("x").warnings[0]).toContain("must be an object")
    expect(validateOptions(undefined).warnings).toEqual([])
  })

  test("keybind false", () => {
    expect(validateOptions({ keybind: false }).config.keybind).toBe(false)
  })
})

describe("mergeOptions", () => {
  test("later layers win; bridge is merged one level deep", () => {
    expect(mergeOptions({ action: "open", bridge: { port: 1 } }, undefined, { bridge: { enabled: false } }, { action: "editor" })).toEqual({
      action: "editor",
      bridge: { port: 1, enabled: false },
    })
  })
  test("undefined values do not override", () => {
    expect(mergeOptions({ action: "open" }, { action: undefined })).toEqual({ action: "open" })
  })
})

describe("specMatchesPackage / findPluginOptions", () => {
  test("npm and git specs", () => {
    for (const s of [
      PACKAGE_NAME,
      `${PACKAGE_NAME}@0.1.0`,
      `${PACKAGE_NAME}@latest`,
      `npm:${PACKAGE_NAME}`,
      "github:daropotter/opencode-filelink",
      "github:daropotter/opencode-filelink#v0.1.0",
      "daropotter/opencode-filelink",
      "git+https://github.com/daropotter/opencode-filelink.git",
    ]) {
      expect(specMatchesPackage(s, "/nowhere")).toBe(true)
    }
    for (const s of ["opencode-other", "@daropotter/opencode-browser", "github:daropotter/opencode-filelink-x", "./nope"]) {
      expect(specMatchesPackage(s, "/nowhere")).toBe(false)
    }
  })

  test("local path spec matches by package.json name", () => {
    const root = tree({ "plugins/mine/package.json": JSON.stringify({ name: PACKAGE_NAME }), "plugins/other/package.json": '{"name":"x"}' })
    expect(specMatchesPackage("./plugins/mine", root)).toBe(true)
    expect(specMatchesPackage(join(root, "plugins", "mine"), "/elsewhere")).toBe(true)
    expect(specMatchesPackage(require("node:url").pathToFileURL(join(root, "plugins", "mine")).href, "/x")).toBe(true)
    expect(specMatchesPackage("./plugins/other", root)).toBe(false)
  })

  test("object entries, tuple entries, legacy key, string entries", () => {
    const cfg = {
      plugin: [[PACKAGE_NAME, { action: "open" }]],
      plugins: ["some-other", { package: "x", options: { action: "editor" } }, { package: PACKAGE_NAME, options: { toast: false } }],
    }
    expect(findPluginOptions(cfg, "/")).toEqual({ action: "open", toast: false })
    expect(findPluginOptions({ plugins: [PACKAGE_NAME] }, "/")).toBeUndefined()
    expect(findPluginOptions({ plugins: [{ package: PACKAGE_NAME }] }, "/")).toEqual({})
    expect(findPluginOptions(null, "/")).toBeUndefined()
    expect(findPluginOptions({ plugins: "nope" }, "/")).toBeUndefined()
  })
})

describe("loadConfig", () => {
  const entry = (options: object) => JSON.stringify({ plugins: [{ package: PACKAGE_NAME, options }] })

  test("precedence: defaults < global < project < setup options", () => {
    const home = tree({
      ".config/opencode/opencode.json": entry({ action: "open", toast: false, bridge: { port: 1111 } }),
    })
    const proj = tree({
      ".git": null,
      "opencode.jsonc": `{
        // project config
        "plugins": [
          { "package": "${PACKAGE_NAME}", "options": { "action": "editor", "editor": "zed", }, },
        ],
      }`,
    })
    const r = loadConfig({ projectDir: proj, homeDir: home, env: {}, setupOptions: { allowOutsideProject: true } })
    expect(r.warnings).toEqual([])
    expect(r.sources.map((s) => s.file)).toEqual([join(home, ".config/opencode/opencode.json"), join(proj, "opencode.jsonc")])
    expect(r.config).toMatchObject({
      action: "editor",
      editor: ["zed", "{file}:{line}:{col}"],
      toast: false,
      allowOutsideProject: true,
      bridge: { enabled: true, port: 1111 },
    })
  })

  test("setup options override files", () => {
    const home = tree({ ".config/opencode/opencode.json": entry({ action: "open" }) })
    const r = loadConfig({ homeDir: home, env: {}, setupOptions: { action: "reveal" } })
    expect(r.config.action).toBe("reveal")
  })

  test("XDG_CONFIG_HOME, OPENCODE_CONFIG, cli.json and .opencode/ are read", () => {
    const xdg = tree({ "opencode/cli.json": entry({ keybind: "ctrl+l" }) })
    const extra = tree({ "custom.json": entry({ toast: false }) })
    const proj = tree({ ".opencode/opencode.json": entry({ intercept: false }) })
    const r = loadConfig({
      projectDir: proj,
      homeDir: "/nonexistent-home",
      env: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: join(extra, "custom.json") },
    })
    expect(r.config).toMatchObject({ keybind: "ctrl+l", toast: false, intercept: false })
  })

  test("walks up to the git root; inner files win", () => {
    const root = tree({
      ".git": null,
      "opencode.json": entry({ action: "open", toast: false }),
      "packages/app/opencode.json": entry({ action: "editor" }),
    })
    const r = loadConfig({ projectDir: join(root, "packages", "app"), homeDir: "/nonexistent-home", env: {} })
    expect(r.config).toMatchObject({ action: "editor", toast: false })
    expect(r.sources).toHaveLength(2)
    expect(r.sources[1]?.options).toEqual({ action: "editor" })
  })

  test("without a git root only the project dir is used", () => {
    const root = tree({ "opencode.json": entry({ action: "open" }), "sub/x": "" })
    const r = loadConfig({ projectDir: join(root, "sub"), homeDir: "/nonexistent-home", env: {} })
    expect(r.config.action).toBe("reveal")
  })

  test("broken files produce warnings, never throw", () => {
    const proj = tree({ "opencode.json": "{ not json", "opencode.jsonc": entry({ action: 5 }) })
    const r = loadConfig({ projectDir: proj, homeDir: "/nonexistent-home", env: {} })
    expect(r.config).toEqual(DEFAULTS)
    expect(r.warnings.some((w) => w.startsWith("could not parse"))).toBe(true)
    expect(r.warnings.some((w) => w.includes('"action"'))).toBe(true)
  })

  test("candidate list contains global then project files", () => {
    const proj = tree({})
    mkdirSync(join(proj, "x"))
    writeFileSync(join(proj, "x", "y"), "")
    const files = configFileCandidates({ projectDir: proj, homeDir: "/h", env: {} })
    expect(files[0]).toBe(join("/h", ".config", "opencode", "opencode.json"))
    expect(files).toContain(join(proj, "opencode.jsonc"))
    expect(files).toContain(join(proj, ".opencode", "opencode.json"))
  })
})

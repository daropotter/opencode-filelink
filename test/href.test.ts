import { describe, expect, test } from "bun:test"
import { isLocalFileHref, parseHref, parseLineFragment, safeDecode, splitLineSuffix } from "../src/core/href.js"

describe("isLocalFileHref", () => {
  test.each([
    "docs/report.md",
    "src/internal/file.go",
    "img/pic.png",
    "./x",
    "../x",
    "/abs/path",
    "~/notes.md",
    "~",
    "README.md",
    "README.md:42",
    "main.go:42:7",
    "src/a.ts#L10",
    "reports/Kredyty%20i%20koszt%20runner%C3%B3w.md",
    "file:///tmp/x",
    "file://localhost/tmp/x",
    "FILE:///tmp/x",
    "file:///C:/x",
    "C:\\Users\\x",
    "C:/Users/x",
    "\\\\server\\share\\x",
    "docs/",
    "Makefile:12",
    "www/index.html",
    "1.2.3/CHANGELOG.md",
    "-rf",
    "--help.md",
  ])("local: %s", (href) => {
    expect(isLocalFileHref(href)).toBe(true)
  })

  test.each([
    "https://example.com",
    "http://localhost:3000/x",
    "mailto:me@example.com",
    "vscode://file/x",
    "ftp://x",
    "data:text/plain,hi",
    "javascript:alert(1)",
    "#section",
    "?q=1",
    "//cdn.example.com/x.js",
    "",
    "   ",
    "C:foo",
    "tel:123",
    "localhost:abc",
    "localhost:8080",
    "sms:123",
    "www.example.com",
    "www.example.com/docs/a.md",
    "127.0.0.1:8080",
    "192.168.1.10/admin",
    "docs/\u0000x",
    "C:\\x\u0000.md",
    "\\\\srv\\x\ny",
    "docs/x\u007f",
  ])("not local: %s", (href) => {
    expect(isLocalFileHref(href)).toBe(false)
  })

  test("non-strings are not local", () => {
    expect(isLocalFileHref(undefined)).toBe(false)
    expect(isLocalFileHref(null)).toBe(false)
    expect(isLocalFileHref(42)).toBe(false)
  })

  test("control characters are rejected", () => {
    expect(isLocalFileHref("docs/\u0007x")).toBe(false)
  })
})

describe("safeDecode", () => {
  test("decodes percent escapes", () => {
    expect(safeDecode("Kredyty%20i%20koszt%20runner%C3%B3w.md")).toBe("Kredyty i koszt runnerów.md")
  })
  test("falls back to the raw string on malformed input", () => {
    expect(safeDecode("100%.md")).toBe("100%.md")
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A")
  })
})

describe("parseLineFragment", () => {
  test.each([
    ["L42", { line: 42 }],
    ["l42", { line: 42 }],
    ["42", { line: 42 }],
    ["L42C7", { line: 42, col: 7 }],
    ["L42:7", { line: 42, col: 7 }],
    ["L42-L50", { line: 42 }],
    ["L42C3-L50C1", { line: 42, col: 3 }],
  ] as const)("%s", (frag, expected) => {
    expect(parseLineFragment(frag)).toEqual(expected)
  })
  test.each(["section", "L0", "", "Lx", "L42x"])("invalid: %s", (frag) => {
    expect(parseLineFragment(frag)).toBeUndefined()
  })
})

describe("splitLineSuffix", () => {
  test("path:42", () => expect(splitLineSuffix("a/b.ts:42")).toEqual({ path: "a/b.ts", line: 42 }))
  test("path:42:7", () => expect(splitLineSuffix("a/b.ts:42:7")).toEqual({ path: "a/b.ts", line: 42, col: 7 }))
  test("no suffix", () => expect(splitLineSuffix("a/b.ts")).toBeUndefined())
  test("drive letter is not a path", () => expect(splitLineSuffix("C:5")).toBeUndefined())
  test("Windows path with suffix", () => expect(splitLineSuffix("C:\\x\\y.ts:3")).toEqual({ path: "C:\\x\\y.ts", line: 3 }))
  test("line 0 is invalid", () => expect(splitLineSuffix("a:0")).toBeUndefined())
  test("col 0 is dropped", () => expect(splitLineSuffix("ab:3:0")).toEqual({ path: "ab", line: 3 }))
})

describe("parseHref", () => {
  test("relative path", () => {
    const p = parseHref("docs/report.md")
    expect(p?.kind).toBe("relative")
    expect(p?.candidates).toEqual([{ path: "docs/report.md" }])
  })

  test("percent-encoded path: decoded first, raw second", () => {
    const p = parseHref("reports/Kredyty%20i%20koszt%20runner%C3%B3w.md")
    expect(p?.candidates.map((c) => c.path)).toEqual([
      "reports/Kredyty i koszt runnerów.md",
      "reports/Kredyty%20i%20koszt%20runner%C3%B3w.md",
    ])
  })

  test("line suffix: full string first, then stripped", () => {
    const p = parseHref("src/file.go:42:7")
    expect(p?.candidates).toEqual([{ path: "src/file.go:42:7" }, { path: "src/file.go", line: 42, col: 7 }])
  })

  test("#L fragment", () => {
    expect(parseHref("src/a.ts#L42")?.candidates).toEqual([{ path: "src/a.ts", line: 42 }])
    expect(parseHref("src/a.ts#L42C7")?.candidates).toEqual([{ path: "src/a.ts", line: 42, col: 7 }])
  })

  test("non-line fragment and query are stripped", () => {
    expect(parseHref("docs/a.md#intro")?.candidates).toEqual([{ path: "docs/a.md" }])
    expect(parseHref("docs/a.md?raw=1")?.candidates).toEqual([{ path: "docs/a.md" }])
  })

  test("./ and ../ and ~", () => {
    expect(parseHref("./x")?.kind).toBe("relative")
    expect(parseHref("../x")?.kind).toBe("relative")
    expect(parseHref("~/x")?.kind).toBe("home")
    expect(parseHref("/x")?.kind).toBe("absolute")
  })

  test("file:// URLs", () => {
    expect(parseHref("file:///tmp/my%20file.md")?.candidates).toEqual([{ path: "/tmp/my file.md" }])
    expect(parseHref("file://localhost/tmp/x")?.candidates).toEqual([{ path: "/tmp/x" }])
    expect(parseHref("file:///C:/Users/x.txt")?.candidates).toEqual([{ path: "C:/Users/x.txt" }])
    expect(parseHref("file://server/share/x")?.candidates).toEqual([{ path: "\\\\server\\share\\x" }])
    expect(parseHref("file:///tmp/a.ts#L5")?.candidates).toEqual([{ path: "/tmp/a.ts", line: 5 }])
    expect(parseHref("file:///tmp/x")?.kind).toBe("file-url")
  })

  test("Windows and UNC paths", () => {
    expect(parseHref("C:\\x\\y.txt")?.kind).toBe("windows")
    expect(parseHref("\\\\srv\\share\\y.txt")?.kind).toBe("unc")
  })

  test("non-local hrefs return undefined", () => {
    expect(parseHref("https://example.com/a.md")).toBeUndefined()
    expect(parseHref("#top")).toBeUndefined()
    expect(parseHref("docs#")?.candidates).toEqual([{ path: "docs" }])
    expect(parseHref("?x")).toBeUndefined()
  })

  test("decoded and suffix variants combine", () => {
    const p = parseHref("my%20dir/a.go:3")
    expect(p?.candidates).toEqual([
      { path: "my dir/a.go:3" },
      { path: "my%20dir/a.go:3" },
      { path: "my dir/a.go", line: 3 },
      { path: "my%20dir/a.go", line: 3 },
    ])
  })
})

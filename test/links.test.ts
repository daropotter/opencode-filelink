import { describe, expect, test } from "bun:test"
import { extractLocalLinks } from "../src/core/links.js"
import { linksFromMessages } from "../src/tui.js"

describe("extractLocalLinks", () => {
  test("inline links, images, angle brackets and titles", () => {
    const md = [
      "See [the report](docs/report.md) and [handler](src/internal/file.go:42).",
      "![pic](img/pic.png) and [web](https://example.com) and [mail](mailto:a@b.c).",
      '[spaced](<reports/my file.md>) [titled](docs/a.md "Title") [anchor](#x)',
      "[enc](reports/Kredyty%20i%20koszt%20runner%C3%B3w.md) [abs](/etc/hosts) [home](~/notes.md)",
      "[nested [brackets]](docs/nested.md) [parens](docs/a_(1).md)",
    ].join("\n")
    expect(extractLocalLinks(md).map((l) => l.href)).toEqual([
      "docs/report.md",
      "src/internal/file.go:42",
      "img/pic.png",
      "reports/my file.md",
      "docs/a.md",
      "reports/Kredyty%20i%20koszt%20runner%C3%B3w.md",
      "/etc/hosts",
      "~/notes.md",
      "docs/nested.md",
      "docs/a_(1).md",
    ])
  })

  test("labels are kept", () => {
    expect(extractLocalLinks("[the report](docs/report.md)")).toEqual([{ href: "docs/report.md", text: "the report" }])
    expect(extractLocalLinks("[](docs/x.md)")).toEqual([{ href: "docs/x.md", text: "docs/x.md" }])
  })

  test("reference definitions and file autolinks", () => {
    const md = "Text [r][1].\n\n[1]: docs/ref.md\n[w]: https://x.y\n<file:///tmp/a.txt> <https://x.y>"
    expect(extractLocalLinks(md).map((l) => l.href)).toEqual(["docs/ref.md", "file:///tmp/a.txt"])
  })

  test("links inside code are ignored", () => {
    const md = "```md\n[x](docs/in-fence.md)\n```\nand `[y](docs/in-span.md)` but [z](docs/real.md)"
    expect(extractLocalLinks(md).map((l) => l.href)).toEqual(["docs/real.md"])
  })

  test("duplicates are removed", () => {
    expect(extractLocalLinks("[a](x.md) [b](x.md)")).toHaveLength(1)
  })
})

describe("linksFromMessages", () => {
  test("assistant and user text parts, newest message first", () => {
    const messages = [
      { type: "user", text: "look at [a](a.md)" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "[b](b.md) [a](a.md)" },
          { type: "reasoning", text: "[r](r.md)" },
        ],
      },
      { type: "system", content: [{ type: "text", text: "[s](s.md)" }] },
      {
        type: "assistant",
        content: [
          { type: "tool", text: "[t](t.md)" },
          { type: "text", text: "[c](c.md)" },
        ],
      },
    ]
    expect(linksFromMessages(messages)).toEqual(["c.md", "b.md", "a.md"])
  })
  test("tolerates odd shapes", () => {
    expect(linksFromMessages([{ type: "assistant", content: "nope" }, { type: "assistant" }] as never)).toEqual([])
  })
})

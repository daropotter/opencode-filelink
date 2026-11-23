import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { isLocalFileHref } from "../src/core/href.js"
import { installLinkInterceptor } from "../src/core/intercept.js"
import tuiPlugin, { setupTui } from "../src/tui.js"
import type { KeymapCommand, RendererLike, TuiContext } from "../src/types.js"
import { fakeSpawner, tempTree } from "./helpers.js"

const tick = () => new Promise((r) => setTimeout(r, 5))

/** A renderer whose prototype has getLinkAt, like @opentui/core's CliRenderer. */
class FakeRenderer {
  links = new Map<string, string>()
  calls = 0
  getLinkAt(x: number, y: number): string | null {
    this.calls++
    return this.links.get(`${x},${y}`) ?? null
  }
}

describe("installLinkInterceptor", () => {
  test("swallows local links, passes others through, calls onLink asynchronously", async () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/report.md")
    r.links.set("2,2", "https://example.com")
    r.links.set("3,3", "mailto:a@b.c")
    const handled: string[] = []
    const h = installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: isLocalFileHref, onLink: (u) => handled.push(u) })
    expect(h.installed).toBe(true)
    expect(Object.hasOwn(r, "getLinkAt")).toBe(true)
    expect(r.getLinkAt(1, 1)).toBeNull()
    expect(handled).toEqual([]) // async
    await tick()
    expect(handled).toEqual(["docs/report.md"])
    expect(r.getLinkAt(2, 2)).toBe("https://example.com")
    expect(r.getLinkAt(3, 3)).toBe("mailto:a@b.c")
    expect(r.getLinkAt(9, 9)).toBeNull()
    expect(r.calls).toBe(4) // original still consulted with the right `this`
    await tick()
    expect(handled).toEqual(["docs/report.md"])
  })

  test("uninstall restores the prototype method", () => {
    const r = new FakeRenderer()
    const h = installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: () => true, onLink: () => {} })
    h.uninstall()
    expect(Object.hasOwn(r, "getLinkAt")).toBe(false)
    expect(r.getLinkAt).toBe(FakeRenderer.prototype.getLinkAt)
  })

  test("chains with an existing own-property wrapper and restores it", async () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/a.md")
    const other = function (this: FakeRenderer, x: number, y: number) {
      return FakeRenderer.prototype.getLinkAt.call(this, x, y)
    }
    ;(r as unknown as Record<string, unknown>).getLinkAt = other
    const handled: string[] = []
    const h = installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: isLocalFileHref, onLink: (u) => handled.push(u) })
    expect(r.getLinkAt(1, 1)).toBeNull()
    await tick()
    expect(handled).toEqual(["docs/a.md"])
    h.uninstall()
    expect(r.getLinkAt).toBe(other as never)
  })

  test("a later wrapper on top keeps working after uninstall (ours goes inert)", () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/a.md")
    const handled: string[] = []
    const h = installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: isLocalFileHref, onLink: (u) => handled.push(u) })
    const ours = r.getLinkAt
    ;(r as unknown as Record<string, unknown>).getLinkAt = function (this: FakeRenderer, x: number, y: number) {
      return ours.call(this, x, y)
    }
    h.uninstall()
    expect(r.getLinkAt(1, 1)).toBe("docs/a.md")
  })

  test("re-installing over a stale wrapper unwraps it (hot reload)", async () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/a.md")
    const first: string[] = []
    const second: string[] = []
    installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: isLocalFileHref, onLink: (u) => first.push(u) })
    const h2 = installLinkInterceptor(r as unknown as RendererLike, { shouldIntercept: isLocalFileHref, onLink: (u) => second.push(u) })
    r.getLinkAt(1, 1)
    await tick()
    expect(first).toEqual([])
    expect(second).toEqual(["docs/a.md"])
    h2.uninstall()
    expect(Object.hasOwn(r, "getLinkAt")).toBe(false)
  })

  test("missing API is reported, not thrown", () => {
    expect(installLinkInterceptor(undefined, { shouldIntercept: () => true, onLink: () => {} })).toMatchObject({
      installed: false,
      reason: expect.stringContaining("no renderer"),
    })
    expect(installLinkInterceptor({} as RendererLike, { shouldIntercept: () => true, onLink: () => {} })).toMatchObject({
      installed: false,
      reason: expect.stringContaining("getLinkAt is not available"),
    })
    const frozen = Object.freeze(new FakeRenderer())
    const h = installLinkInterceptor(frozen as unknown as RendererLike, { shouldIntercept: () => true, onLink: () => {} })
    expect(h.installed).toBe(false)
  })

  test("errors in callbacks are contained", async () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/a.md")
    const logs: string[] = []
    installLinkInterceptor(r as unknown as RendererLike, {
      shouldIntercept: () => {
        throw new Error("bad")
      },
      onLink: () => {},
      log: (m) => logs.push(m),
    })
    expect(r.getLinkAt(1, 1)).toBe("docs/a.md")
    const r2 = new FakeRenderer()
    r2.links.set("1,1", "docs/a.md")
    installLinkInterceptor(r2 as unknown as RendererLike, {
      shouldIntercept: () => true,
      onLink: () => {
        throw new Error("worse")
      },
      log: (m) => logs.push(m),
    })
    expect(r2.getLinkAt(1, 1)).toBeNull()
    await tick()
    expect(logs).toEqual(["shouldIntercept failed: bad", "link handler failed: worse"])
  })
})

let project: ReturnType<typeof tempTree>
beforeAll(() => {
  project = tempTree({ "docs/report.md": "x", "src/main.go": "x", "session/dir/note.md": "x" })
})
afterAll(() => project.cleanup())

function fakeCtx(
  o: {
    renderer?: RendererLike
    route?: { type: string; sessionID?: string }
    messages?: unknown[]
    options?: Record<string, unknown>
  } = {},
) {
  const toasts: { message: string; variant?: string }[] = []
  const commands: KeymapCommand[] = []
  const layerModes: (string | undefined)[] = []
  const selects: {
    title: string
    options: readonly { title: string; value: string; description?: string }[]
    actions?: readonly { bind: string; title: string; onTrigger: (v: string) => void }[]
  }[] = []
  let selectResult: string | undefined
  let cleared = 0
  const ctx: TuiContext = {
    options: o.options ?? {},
    location: { directory: project.root },
    renderer: o.renderer ?? (new FakeRenderer() as unknown as RendererLike),
    data: {
      session: {
        get: (id) =>
          id === "ses_2" ? { location: { directory: join(project.root, "session", "dir") } } : { location: { directory: project.root } },
        message: { list: () => (o.messages ?? []) as never, sync: async () => {} },
      },
    },
    keymap: {
      layer: (factory) => {
        const layer = factory()
        layerModes.push(layer.mode)
        commands.push(...(layer.commands ?? []))
      },
    },
    ui: {
      toast: { show: (t) => toasts.push(t) },
      dialog: {
        select: async (opts) => {
          selects.push(opts as never)
          return selectResult as never
        },
        clear: () => {
          cleared++
        },
      },
      router: { current: () => o.route ?? { type: "home" } },
    },
  }
  return {
    ctx,
    toasts,
    commands,
    layerModes,
    selects,
    setSelect: (v: string | undefined) => {
      selectResult = v
    },
    cleared: () => cleared,
  }
}

describe("setupTui", () => {
  test("click on a local link runs the action and shows a toast", async () => {
    const r = new FakeRenderer()
    r.links.set("5,5", "docs/report.md")
    r.links.set("6,6", "https://example.com")
    const f = fakeCtx({ renderer: r as unknown as RendererLike })
    const { spawner, calls } = fakeSpawner()
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner }, log: () => {} })
    expect(h.interceptor.installed).toBe(true)
    expect(r.getLinkAt(5, 5)).toBeNull()
    expect(r.getLinkAt(6, 6)).toBe("https://example.com")
    await tick()
    expect(calls).toEqual([expect.objectContaining({ cmd: "open", args: ["-R", join(project.root, "docs", "report.md")] })])
    expect(f.toasts).toEqual([
      expect.objectContaining({ variant: "success", message: `Revealed ${join("docs", "report.md")} in the file manager` }),
    ])
    h.cleanup()
    expect(Object.hasOwn(r, "getLinkAt")).toBe(false)
  })

  test("web links, mail links and anchors reach opencode's own handler untouched", async () => {
    const r = new FakeRenderer()
    const web = [
      "https://example.com/a.md",
      "http://127.0.0.1:4096/x",
      "mailto:me@example.com",
      "#section",
      "www.example.com",
      "vscode://file/x",
    ]
    for (const [i, u] of web.entries()) r.links.set(`${i},0`, u)
    const f = fakeCtx({ renderer: r as unknown as RendererLike })
    const { spawner, calls } = fakeSpawner()
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner }, log: () => {} })
    for (const [i, u] of web.entries()) expect(r.getLinkAt(i, 0)).toBe(u)
    await tick()
    expect(calls).toHaveLength(0)
    expect(f.toasts).toHaveLength(0)
    h.cleanup()
  })

  test("a click is handled exactly once, even when the plugin is loaded twice", async () => {
    const r = new FakeRenderer()
    r.links.set("1,1", "docs/report.md")
    const f = fakeCtx({ renderer: r as unknown as RendererLike })
    const { spawner, calls } = fakeSpawner()
    const a = setupTui(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner }, log: () => {} })
    const b = setupTui(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner }, log: () => {} })
    expect(r.getLinkAt(1, 1)).toBeNull()
    await tick()
    await tick()
    expect(calls).toHaveLength(1)
    b.cleanup()
    a.cleanup()
    expect(Object.hasOwn(r, "getLinkAt")).toBe(false)
    expect(r.getLinkAt(1, 1)).toBe("docs/report.md")
  })

  test("fallbacks are shown as a warning toast", async () => {
    const f = fakeCtx({ options: { action: "open" } })
    const t = tempTree({ "x.desktop": "x" })
    try {
      const h = setupTui(
        { ...f.ctx, location: { directory: t.root } },
        { skipConfigFiles: true, platform: "linux", exec: { spawner: fakeSpawner().spawner }, log: () => {} },
      )
      const o = await h.handleLink("x.desktop")
      expect(o).toMatchObject({ ok: true, action: "reveal" })
      expect(f.toasts).toEqual([expect.objectContaining({ variant: "warning" })])
      expect(f.toasts[0]?.message).toContain("executable")
      h.cleanup()
    } finally {
      t.cleanup()
    }
  })

  test("errors always toast; success toast can be disabled", async () => {
    const f = fakeCtx({ options: { toast: false } })
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner: fakeSpawner().spawner }, log: () => {} })
    await h.handleLink("docs/report.md")
    expect(f.toasts).toEqual([])
    await h.handleLink("docs/missing.md")
    expect(f.toasts).toEqual([expect.objectContaining({ variant: "error", message: `File not found: ${join("docs", "missing.md")}` })])
    h.cleanup()
  })

  test("relative links resolve against the current session's directory", async () => {
    const f = fakeCtx({ route: { type: "session", sessionID: "ses_2" } })
    const { spawner, calls } = fakeSpawner()
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner }, log: () => {} })
    const o = await h.handleLink("note.md")
    expect(o.ok).toBe(true)
    expect(calls[0]?.args).toEqual(["-R", join(project.root, "session", "dir", "note.md")])
    h.cleanup()
  })

  test("intercept: false leaves the renderer alone", () => {
    const r = new FakeRenderer()
    const f = fakeCtx({ renderer: r as unknown as RendererLike, options: { intercept: false } })
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner: fakeSpawner().spawner }, log: () => {} })
    expect(h.interceptor.installed).toBe(false)
    expect(Object.hasOwn(r, "getLinkAt")).toBe(false)
  })

  test("missing getLinkAt: logs and shows a one-time warning toast", async () => {
    const logs: string[] = []
    const f = fakeCtx({ renderer: {} as RendererLike })
    const h = setupTui(f.ctx, {
      skipConfigFiles: true,
      platform: "linux",
      exec: { spawner: fakeSpawner().spawner },
      log: (m) => logs.push(m),
    })
    expect(h.interceptor.installed).toBe(false)
    expect(logs.some((l) => l.includes("click interception unavailable"))).toBe(true)
    await new Promise((r) => setTimeout(r, 1600))
    expect(f.toasts).toEqual([expect.objectContaining({ variant: "warning", message: expect.stringContaining("/links") })])
  })

  test("registers /links with alias and optional keybind", () => {
    const f = fakeCtx({ options: { keybind: "<leader>l" } })
    setupTui(f.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner: fakeSpawner().spawner }, log: () => {} }).cleanup()
    expect(f.commands).toHaveLength(1)
    expect(f.layerModes).toEqual(["global"]) // "base" is not reachable from palette/slash in 2.2.0
    expect(f.commands[0]).toMatchObject({
      id: "filelink.links",
      slash: { name: "links", aliases: ["files"] },
      palette: true,
      bind: "<leader>l",
    })
    const g = fakeCtx()
    setupTui(g.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner: fakeSpawner().spawner }, log: () => {} }).cleanup()
    expect(g.commands[0]?.bind).toBeUndefined()
  })

  test("/links lists session links and recent clicks, opens the chosen one", async () => {
    const messages = [
      {
        type: "assistant",
        content: [{ type: "text", text: "See [r](docs/report.md) and [m](src/main.go:3) and [x](docs/gone.md) and [w](https://x.y)" }],
      },
    ]
    ;(globalThis as Record<symbol, unknown>)[Symbol.for("opencode-filelink.recent")] = []
    const f = fakeCtx({ route: { type: "session", sessionID: "ses_1" }, messages, options: { editor: "vscode" } })
    const { spawner, calls } = fakeSpawner()
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner }, log: () => {} })
    await h.handleLink("/etc/passwd") // recorded as recent even though refused
    f.toasts.length = 0
    f.setSelect("src/main.go:3")
    f.commands[0]?.run()
    await tick()
    await tick()
    expect(f.selects).toHaveLength(1)
    const sel = f.selects[0]!
    expect(sel.title).toBe("File links")
    expect(sel.options.map((o) => [o.title, o.description])).toEqual([
      ["docs/report.md", undefined],
      ["src/main.go:3", undefined],
      ["docs/gone.md", "missing"],
      ["/etc/passwd", "outside project"],
    ])
    expect(sel.actions?.map((a) => `${a.bind}:${a.title}`)).toEqual(["ctrl+r:reveal", "ctrl+o:open", "ctrl+e:editor"])
    expect(calls[0]).toMatchObject({ cmd: "code", args: ["-g", `${join(project.root, "src", "main.go")}:3`] })

    // footer action: reveal
    calls.length = 0
    sel.actions?.[0]?.onTrigger("docs/report.md")
    await tick()
    expect(f.cleared()).toBe(1)
    expect(calls[0]?.cmd).toBe("busctl")
    h.cleanup()
  })

  test("/links with nothing to show toasts instead of an empty dialog", async () => {
    ;(globalThis as Record<symbol, unknown>)[Symbol.for("opencode-filelink.recent")] = []
    const f = fakeCtx({ route: { type: "session", sessionID: "ses_1" }, messages: [] })
    const h = setupTui(f.ctx, { skipConfigFiles: true, platform: "linux", exec: { spawner: fakeSpawner().spawner }, log: () => {} })
    await h.openLinksDialog()
    expect(f.selects).toHaveLength(0)
    expect(f.toasts[0]?.message).toContain("No local file links")
    h.cleanup()
  })

  test("default export has the V2 TUI shape and never throws", async () => {
    expect(tuiPlugin.id).toBe("opencode-filelink")
    expect(typeof tuiPlugin.setup).toBe("function")
    const cleanup = await tuiPlugin.setup({} as TuiContext)
    expect(typeof cleanup === "function" || cleanup === undefined).toBe(true)
    if (typeof cleanup === "function") await cleanup()
    // a context whose getters throw
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile")
        },
      },
    ) as TuiContext
    expect(await tuiPlugin.setup(hostile)).toBeUndefined()
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { startBridge } from "../src/core/bridge.js"
import serverPlugin, { createTools, rewriteInstruction, setupServer, stripBridgeUrls } from "../src/server.js"
import type { ServerContext, ToolInfo } from "../src/types.js"
import { fakeSpawner, tempTree } from "./helpers.js"

let project: ReturnType<typeof tempTree>
beforeAll(() => {
  project = tempTree({ "docs/report.md": "x", "src/main.go": "x" })
})
afterAll(() => project.cleanup())

function fakeServerCtx(options: Record<string, unknown> = {}) {
  const tools: ToolInfo[] = []
  const hooks: { name: string; cb: (input: any) => void | Promise<void> }[] = []
  const ctx: ServerContext = {
    options,
    location: { directory: project.root, project: { directory: project.root } },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) })
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks.push({ name, cb })
      },
    },
  }
  return { ctx, tools, hooks }
}

describe("createTools", () => {
  test("tool definitions use `name` and JSON Schema input", () => {
    const tools = createTools(async () => ({ ok: true, message: "ok" }))
    expect(tools.map((t) => t.name)).toEqual(["open_file", "reveal_file"])
    for (const t of tools) {
      expect(t).not.toHaveProperty("id")
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.input).toMatchObject({ type: "object", required: ["path"] })
    }
    expect(tools[0]?.input).toMatchObject({
      properties: { path: { type: "string" }, line: { type: "integer" }, action: { enum: ["reveal", "open", "editor"] } },
    })
  })

  test("open_file passes path, line and action; validates input", async () => {
    const reqs: unknown[] = []
    const [openFile, revealFile] = createTools(async (req) => {
      reqs.push(req)
      return { ok: true, message: "done", action: "reveal" }
    })
    expect(await openFile!.execute({ path: "docs/a.md", line: 3, action: "editor" })).toMatchObject({
      output: "done",
      metadata: { ok: true },
    })
    await openFile!.execute({ path: "docs/a.md", line: -1, action: "rm -rf" })
    await revealFile!.execute({ path: "x" })
    expect(reqs).toEqual([{ href: "docs/a.md", line: 3, action: "editor" }, { href: "docs/a.md" }, { href: "x", action: "reveal" }])
    expect(await openFile!.execute({})).toMatchObject({ output: "Error: path is required", metadata: { ok: false } })
    expect(await revealFile!.execute({ path: 5 })).toMatchObject({ metadata: { ok: false } })
  })

  test("successful output includes a bridge link when the bridge runs", async () => {
    const bridge = await startBridge({ handler: async () => ({ ok: true, message: "" }) })
    try {
      const [openFile] = createTools(
        async () => ({ ok: true, message: "Revealed a.md" }),
        () => bridge,
      )
      const r = await openFile!.execute({ path: "a.md" })
      expect(r.output).toContain("Revealed a.md")
      expect(r.output).toContain(bridge.url("a.md"))
      const [failing] = createTools(
        async () => ({ ok: false, message: "File not found: a.md" }),
        () => bridge,
      )
      expect((await failing!.execute({ path: "a.md" })).output).toBe("File not found: a.md")
    } finally {
      await bridge.close()
    }
  })
})

describe("setupServer", () => {
  test("registers tools and starts the bridge by default", async () => {
    const f = fakeServerCtx()
    const { spawner, calls } = fakeSpawner()
    const cleanup = await setupServer(f.ctx, { skipConfigFiles: true, platform: "darwin", exec: { spawner }, log: () => {} })
    try {
      expect(f.tools.map((t) => t.name)).toEqual(["open_file", "reveal_file"])
      expect(f.hooks).toHaveLength(0)
      const r = await f.tools[0]!.execute({ path: "docs/report.md" })
      expect(r.metadata?.ok).toBe(true)
      expect(calls[0]).toMatchObject({ cmd: "open", args: ["-R", join(project.root, "docs", "report.md")] })
      const url = /http:\/\/127\.0\.0\.1:\d+\/open\?\S+/.exec(r.output ?? "")?.[0]
      expect(url).toBeTruthy()
      // the bridge performs the same action
      const res = await fetch(url!)
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(2)
      // outside the project is refused through the bridge as well
      const outside = new URL(url!)
      outside.searchParams.set("path", "../../etc/passwd")
      expect((await fetch(outside)).status).toBe(422)
    } finally {
      await cleanup()
    }
  })

  test("tools: false and bridge disabled", async () => {
    const f = fakeServerCtx({ tools: false, bridge: { enabled: false } })
    const cleanup = await setupServer(f.ctx, { skipConfigFiles: true, platform: "linux", log: () => {} })
    expect(f.tools).toHaveLength(0)
    await cleanup()
  })

  test("linkRewrite: instruct adds a system part and strips bridge URLs from history", async () => {
    const logs: string[] = []
    const f = fakeServerCtx({ linkRewrite: "instruct", bridge: { enabled: false } })
    const cleanup = await setupServer(f.ctx, { skipConfigFiles: true, platform: "linux", log: (m) => logs.push(m) })
    try {
      expect(f.hooks.map((h) => h.name)).toEqual(["context"])
      const urlInTool = /http:\/\/127\.0\.0\.1:\d+\/open\?\S+/.exec((await f.tools[0]!.execute({ path: "docs/report.md" })).output ?? "")
      expect(urlInTool).toBeTruthy() // bridge started for instruct mode even with bridge.enabled false
      const input = {
        system: [] as { type: string; text: string }[],
        messages: [{ role: "assistant", content: [{ type: "text", text: `see [r](${urlInTool![0]})` }] }],
      }
      await f.hooks[0]!.cb(input)
      expect(input.system).toHaveLength(1)
      expect(input.system[0]?.text).toContain("/open?")
      expect(input.system[0]?.text).toContain("t=")
      expect(input.messages[0]?.content[0]?.text).toBe("see [r](docs/report.md)")
      expect(logs.some((l) => l.includes("token is sent to the model provider"))).toBe(true)
      // hostile input does not throw
      await f.hooks[0]!.cb(undefined)
      await f.hooks[0]!.cb({ system: "nope", messages: 5 })
    } finally {
      await cleanup()
    }
  })

  test("failing host APIs never throw", async () => {
    const ctx: ServerContext = {
      location: { directory: project.root },
      tool: {
        transform: async () => {
          throw new Error("transform broke")
        },
      },
      session: {
        hook: async () => {
          throw new Error("hook broke")
        },
      },
      options: { linkRewrite: "instruct", bridge: { port: 1 } },
    }
    const logs: string[] = []
    const cleanup = await setupServer(ctx, { skipConfigFiles: true, platform: "linux", log: (m) => logs.push(m) })
    await cleanup()
    expect(logs.some((l) => l.includes("tool registration failed: transform broke"))).toBe(true)
  })

  test("editor.add throwing is contained inside the transform callback", async () => {
    let threw = false
    const ctx: ServerContext = {
      location: { directory: project.root },
      options: { bridge: false },
      tool: {
        transform: async (cb) => {
          try {
            cb({
              add: () => {
                throw new Error("bad tool")
              },
            })
          } catch {
            threw = true
          }
        },
      },
    }
    const cleanup = await setupServer(ctx, { skipConfigFiles: true, platform: "linux", log: () => {} })
    await cleanup()
    expect(threw).toBe(false)
  })

  test("default export has the V2 shape and never throws", async () => {
    expect(serverPlugin.id).toBe("opencode-filelink")
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile")
        },
      },
    ) as ServerContext
    expect(await serverPlugin.setup(hostile)).toBeUndefined()
    const cleanup = await serverPlugin.setup({ location: { directory: project.root }, options: { bridge: false } })
    expect(typeof cleanup).toBe("function")
    await cleanup?.()
  })
})

describe("rewrite helpers", () => {
  test("rewriteInstruction mentions the URL form", async () => {
    const bridge = await startBridge({ handler: async () => ({ ok: true, message: "" }) })
    try {
      const text = rewriteInstruction(bridge)
      expect(text).toContain(bridge.origin)
      expect(text).toContain("&line=")
      expect(text).toContain(`t=${bridge.token}`)
    } finally {
      await bridge.close()
    }
  })

  test("stripBridgeUrls only touches text fields", () => {
    const re = /http:\/\/127\.0\.0\.1:9\/open\?[^\s)]*/g
    const msgs = [
      {
        text: "a http://127.0.0.1:9/open?path=x.md&line=2&t=k b",
        url: "http://127.0.0.1:9/open?path=y&t=k",
        nested: [{ text: "[q](http://127.0.0.1:9/open?path=q&t=k)" }],
      },
    ]
    stripBridgeUrls(msgs, re)
    expect(msgs[0]?.text).toBe("a x.md:2 b")
    expect(msgs[0]?.url).toBe("http://127.0.0.1:9/open?path=y&t=k")
    expect(msgs[0]?.nested[0]?.text).toBe("[q](q)")
    stripBridgeUrls(null, re)
    stripBridgeUrls([Object.freeze({ text: "http://127.0.0.1:9/open?path=z&t=k" })], re)
  })
})

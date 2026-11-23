/**
 * Server part: `open_file` / `reveal_file` agent tools, the localhost bridge
 * and the optional `linkRewrite: "instruct"` system instruction.
 * Registration must never throw: a failing server setup disables the whole
 * plugin in opencode 2.2.0, TUI part included.
 */
import { type FilelinkConfig, loadConfig, PLUGIN_ID, validateOptions } from "./config.js"
import { type Bridge, bridgeUrlToPath, startBridge } from "./core/bridge.js"
import type { ExecOptions } from "./core/exec.js"
import { createLogger, type Logger } from "./core/log.js"
import { type OpenOutcome, type OpenRequest, openLink } from "./core/opener.js"
import { detectPlatform, type Platform } from "./core/platform.js"
import { execOptionsFromEnv } from "./core/runtime.js"
import type { Action, PluginDefinition, ServerContext, ToolInfo, ToolResult } from "./types.js"

export interface ServerDeps {
  readonly platform?: Platform
  readonly exec?: ExecOptions
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly log?: Logger
  /** Skip reading opencode config files (tests). */
  readonly skipConfigFiles?: boolean
}

export type Opener = (req: OpenRequest) => Promise<OpenOutcome>

const ACTION_ENUM = ["reveal", "open", "editor"] as const

function toolOutput(outcome: OpenOutcome, bridge: Bridge | undefined, path: string, line?: number): ToolResult {
  let output = outcome.message
  if (outcome.ok && bridge) {
    output += `\nClickable link for the user (opens via the local bridge): ${bridge.url(path, line !== undefined ? { line } : {})}`
  }
  return {
    output,
    metadata: {
      ok: outcome.ok,
      ...(outcome.action ? { action: outcome.action } : {}),
      ...(outcome.target ? { path: outcome.target.path } : {}),
    },
  }
}

/** Agent tool definitions (`Tool.Info` uses `name`, not `id`). */
export function createTools(open: Opener, getBridge: () => Bridge | undefined = () => undefined): ToolInfo[] {
  return [
    {
      name: "open_file",
      description:
        "Show a local file to the user on their machine: reveal it in the system file manager, open it with the default application, or open it in the configured editor at a line. Use when the user asks to see, open or locate a file. Paths are relative to the project directory; files outside the project are refused unless the user allowed it.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path, relative to the project directory, absolute, ~/ or file:// URL." },
          line: {
            type: "integer",
            minimum: 1,
            description: "Optional 1-based line number (opens the editor at that line when one is configured).",
          },
          action: {
            type: "string",
            enum: [...ACTION_ENUM],
            description: "Optional: reveal (file manager), open (default app) or editor. Defaults to the user's configuration.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input: { path?: unknown; line?: unknown; action?: unknown }) {
        const path = typeof input?.path === "string" ? input.path : ""
        if (!path) return { output: "Error: path is required", metadata: { ok: false } }
        const line = typeof input.line === "number" && Number.isInteger(input.line) && input.line > 0 ? input.line : undefined
        const action =
          typeof input.action === "string" && (ACTION_ENUM as readonly string[]).includes(input.action)
            ? (input.action as Action)
            : undefined
        const outcome = await open({ href: path, ...(line !== undefined ? { line } : {}), ...(action ? { action } : {}) })
        return toolOutput(outcome, getBridge(), path, line)
      },
    },
    {
      name: "reveal_file",
      description:
        "Reveal a local file or directory in the user's system file manager (selected in its folder). Paths are relative to the project directory.",
      input: {
        type: "object",
        properties: { path: { type: "string", description: "File or directory path, relative to the project directory." } },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input: { path?: unknown }) {
        const path = typeof input?.path === "string" ? input.path : ""
        if (!path) return { output: "Error: path is required", metadata: { ok: false } }
        return toolOutput(await open({ href: path, action: "reveal" }), getBridge(), path)
      },
    },
  ]
}

/** System instruction for `linkRewrite: "instruct"`. */
export function rewriteInstruction(bridge: Bridge): string {
  const example = bridge.url("docs/report.md")
  const exampleLine = bridge.url("src/main.go", { line: 42 })
  return [
    "When you link to a local file in your reply, write the link target as a URL on the user's local file-link bridge instead of a plain path, so the user can click it:",
    `- ${example.replace("docs%2Freport.md", "<url-encoded path relative to the project directory>")}`,
    `- add &line=<n> for a line, e.g. [main.go:42](${exampleLine})`,
    `Example: [report](${example}). Keep the t= parameter exactly as given. Only use this for files inside the project.`,
  ].join("\n")
}

/** Replace bridge URLs in conversation text with plain paths (in place, best effort). */
export function stripBridgeUrls(value: unknown, pattern: RegExp, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const v of value) stripBridgeUrls(v, pattern, depth + 1)
    return
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const v = obj[key]
    if (typeof v === "string" && key === "text") {
      pattern.lastIndex = 0
      if (pattern.test(v)) {
        pattern.lastIndex = 0
        try {
          obj[key] = v.replace(pattern, (url) => bridgeUrlToPath(url) ?? url)
        } catch {
          // frozen object: leave it
        }
      }
    } else if (v && typeof v === "object") stripBridgeUrls(v, pattern, depth + 1)
  }
}

export async function setupServer(ctx: ServerContext, deps: ServerDeps = {}): Promise<() => Promise<void>> {
  const env = deps.env ?? process.env
  const log = deps.log ?? createLogger("server", { stderr: false, env })
  const projectDir = ctx.location?.directory ?? ctx.location?.project?.directory ?? process.cwd()
  const loaded = deps.skipConfigFiles
    ? { ...validateOptions(ctx.options ?? {}, { projectDir, env }), sources: [] }
    : loadConfig({ projectDir, setupOptions: ctx.options ?? {}, env, ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) })
  const config: FilelinkConfig = loaded.config
  for (const w of loaded.warnings) log(`config: ${w}`)
  const platform = deps.platform ?? detectPlatform({ env })
  const exec = deps.exec ?? execOptionsFromEnv(env, log)
  const roots = [ctx.location?.project?.directory].filter((d): d is string => typeof d === "string")

  const open: Opener = async (req) => {
    const outcome = await openLink(req, {
      config,
      baseDir: projectDir,
      roots,
      platform,
      exec,
      env,
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    })
    log(`${outcome.ok ? "ok" : "fail"}: ${outcome.message}`)
    return outcome
  }

  let bridge: Bridge | undefined
  if (config.bridge.enabled || config.linkRewrite === "instruct") {
    try {
      bridge = await startBridge({
        port: config.bridge.port,
        log,
        handler: async (req) => {
          const o = await open({
            href: req.path,
            ...(req.line !== undefined ? { line: req.line } : {}),
            ...(req.action ? { action: req.action } : {}),
          })
          return { ok: o.ok, message: o.message }
        },
      })
    } catch (err) {
      log(`bridge failed to start: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  if (config.tools && typeof ctx.tool?.transform === "function") {
    try {
      const tools = createTools(open, () => bridge)
      await ctx.tool.transform((editor) => {
        for (const tool of tools) {
          try {
            editor.add(tool)
          } catch (err) {
            log(`could not register tool ${tool.name}: ${(err as Error)?.message}`)
          }
        }
      })
      log(`tools registered: ${tools.map((t) => t.name).join(", ")}`)
    } catch (err) {
      log(`tool registration failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  if (config.linkRewrite === "instruct" && bridge && typeof ctx.session?.hook === "function") {
    const b = bridge
    try {
      await ctx.session.hook("context", (input: { system?: unknown; messages?: unknown }) => {
        try {
          if (Array.isArray(input?.system)) input.system.push({ type: "text", text: rewriteInstruction(b) })
          if (Array.isArray(input?.messages)) stripBridgeUrls(input.messages, b.urlPattern())
        } catch (err) {
          log(`context hook failed: ${(err as Error)?.message}`)
        }
      })
      log("linkRewrite: instruct enabled (the bridge token is sent to the model provider)")
    } catch (err) {
      log(`context hook registration failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  log(`server ready (platform ${platform}, project ${projectDir})`)
  return async () => {
    const b = bridge
    bridge = undefined
    await b?.close().catch(() => {})
  }
}

const plugin: PluginDefinition<ServerContext> = {
  id: PLUGIN_ID,
  async setup(ctx) {
    try {
      return await setupServer(ctx)
    } catch (err) {
      try {
        createLogger("server")(`setup failed: ${(err as Error)?.stack ?? String(err)}`)
      } catch {
        // ignore
      }
      return undefined
    }
  },
}

export default plugin

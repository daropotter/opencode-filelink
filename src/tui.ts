/**
 * TUI part: intercepts clicks on local file links (wraps `renderer.getLinkAt`),
 * provides the `/links` command and shows toasts. Never throws from setup.
 */
import { type FilelinkConfig, loadConfig, PLUGIN_ID, validateOptions } from "./config.js"
import type { ExecOptions } from "./core/exec.js"
import { isLocalFileHref } from "./core/href.js"
import { type InterceptHandle, installLinkInterceptor } from "./core/intercept.js"
import { extractLocalLinks } from "./core/links.js"
import { createLogger, type Logger } from "./core/log.js"
import { type OpenOutcome, openLink } from "./core/opener.js"
import { detectPlatform, type Platform } from "./core/platform.js"
import { resolveTarget } from "./core/resolve.js"
import { execOptionsFromEnv } from "./core/runtime.js"
import type { Action, DialogSelectAction, DialogSelectOption, PluginDefinition, SessionMessageLike, TuiContext } from "./types.js"

export interface TuiDeps {
  readonly platform?: Platform
  readonly exec?: ExecOptions
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly log?: Logger
  readonly skipConfigFiles?: boolean
}

export interface TuiHandle {
  readonly config: FilelinkConfig
  readonly interceptor: InterceptHandle
  handleLink(href: string, action?: Action): Promise<OpenOutcome>
  sessionLinks(): string[]
  openLinksDialog(): Promise<void>
  cleanup(): void
}

const RECENT_MAX = 50
const RECENT_KEY = Symbol.for("opencode-filelink.recent")

/** Recently clicked links survive plugin hot reloads (kept on globalThis). */
function recentStore(): string[] {
  const g = globalThis as unknown as Record<symbol, string[] | undefined>
  g[RECENT_KEY] ??= []
  return g[RECENT_KEY]
}

function messageTexts(msg: SessionMessageLike): string[] {
  const out: string[] = []
  if (typeof msg.text === "string") out.push(msg.text)
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as { type?: unknown; text?: unknown }[]) {
      if (part && part.type === "text" && typeof part.text === "string") out.push(part.text)
    }
  }
  return out
}

/** Local links in messages, most recent message first. */
export function linksFromMessages(messages: readonly SessionMessageLike[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || (msg.type !== "assistant" && msg.type !== "user")) continue
    for (const text of messageTexts(msg)) {
      for (const link of extractLocalLinks(text)) {
        if (seen.has(link.href)) continue
        seen.add(link.href)
        out.push(link.href)
      }
    }
  }
  return out
}

export function setupTui(ctx: TuiContext, deps: TuiDeps = {}): TuiHandle {
  const env = deps.env ?? process.env
  const log = deps.log ?? createLogger("tui", { env })
  const projectDir = ctx.location?.directory ?? ctx.data?.location?.default?.()?.directory ?? process.cwd()
  const loaded = deps.skipConfigFiles
    ? validateOptions(ctx.options ?? {}, { projectDir, env })
    : loadConfig({ projectDir, setupOptions: ctx.options ?? {}, env, ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) })
  const config = loaded.config
  for (const w of loaded.warnings) log(`config: ${w}`)
  const platform = deps.platform ?? detectPlatform({ env })
  const exec = deps.exec ?? execOptionsFromEnv(env, log)

  const toast = (message: string, variant: "info" | "success" | "warning" | "error") => {
    try {
      ctx.ui?.toast?.show({ title: "File link", message, variant, ...(variant === "error" ? { duration: 6000 } : {}) })
    } catch (err) {
      log(`toast failed: ${(err as Error)?.message}`)
    }
  }

  const currentSessionID = (): string | undefined => {
    try {
      const route = ctx.ui?.router?.current?.()
      return route?.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined
    } catch {
      return undefined
    }
  }

  const baseDir = (): string => {
    const id = currentSessionID()
    if (id) {
      try {
        const dir = ctx.data?.session?.get?.(id)?.location?.directory
        if (typeof dir === "string" && dir) return dir
      } catch {
        // fall through
      }
    }
    return projectDir
  }

  const remember = (href: string) => {
    const recent = recentStore()
    const i = recent.indexOf(href)
    if (i >= 0) recent.splice(i, 1)
    recent.unshift(href)
    recent.length = Math.min(recent.length, RECENT_MAX)
  }

  const handleLink = async (href: string, action?: Action): Promise<OpenOutcome> => {
    remember(href)
    const outcome = await openLink(
      { href, ...(action ? { action } : {}) },
      {
        config,
        baseDir: baseDir(),
        roots: [projectDir],
        platform,
        exec,
        env,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      },
    )
    log(`${outcome.ok ? "ok" : "fail"}: ${href} -> ${outcome.message}`)
    if (!outcome.ok) toast(outcome.message, "error")
    else if (config.toast) toast(outcome.message, "success")
    return outcome
  }

  let warnTimer: ReturnType<typeof setTimeout> | undefined
  let interceptor: InterceptHandle = { installed: false, reason: "disabled by config (intercept: false)", uninstall() {} }
  if (config.intercept) {
    interceptor = installLinkInterceptor(ctx.renderer, {
      shouldIntercept: isLocalFileHref,
      onLink: (url) => {
        log(`intercepted click: ${url}`)
        void handleLink(url)
      },
      log,
    })
    if (interceptor.installed) log("click interception installed")
    else {
      log(`click interception unavailable: ${interceptor.reason}`)
      warnTimer = setTimeout(() => toast(`Click interception unavailable (${interceptor.reason}). Use /links instead.`, "warning"), 1500)
    }
  }

  const sessionLinks = (): string[] => {
    const id = currentSessionID()
    let fromMessages: string[] = []
    if (id) {
      try {
        fromMessages = linksFromMessages(ctx.data?.session?.message?.list?.(id) ?? [])
      } catch (err) {
        log(`could not read session messages: ${(err as Error)?.message}`)
      }
    }
    const all = [...fromMessages]
    for (const r of recentStore()) if (!all.includes(r)) all.push(r)
    return all
  }

  const openLinksDialog = async (): Promise<void> => {
    const id = currentSessionID()
    if (id) {
      try {
        await ctx.data?.session?.message?.sync?.(id)
      } catch {
        // cached data is fine
      }
    }
    const links = sessionLinks()
    if (links.length === 0) {
      toast(id ? "No local file links in this session yet" : "No local file links yet (open a session first)", "info")
      return
    }
    const dialog = ctx.ui?.dialog
    if (typeof dialog?.select !== "function") {
      toast("Dialogs are not available in this opencode version", "warning")
      return
    }
    const dir = baseDir()
    const options: DialogSelectOption<string>[] = links.map((href) => {
      const r = resolveTarget(href, {
        baseDir: dir,
        roots: [projectDir, ...config.extraRoots],
        allowOutsideProject: config.allowOutsideProject,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      })
      const description = r.ok
        ? r.isDirectory
          ? "directory"
          : undefined
        : r.code === "not-found"
          ? "missing"
          : r.code === "outside-project"
            ? "outside project"
            : undefined
      return { title: href, value: href, ...(description ? { description } : {}) }
    })
    const act =
      (action: Action): DialogSelectAction<string>["onTrigger"] =>
      (href) => {
        try {
          ctx.ui?.dialog?.clear?.()
        } catch {
          // ignore
        }
        void handleLink(href, action)
      }
    const actions: DialogSelectAction<string>[] = [
      { bind: "ctrl+r", title: "reveal", selection: "required", onTrigger: act("reveal") },
      { bind: "ctrl+o", title: "open", selection: "required", onTrigger: act("open") },
    ]
    if (config.editor) actions.push({ bind: "ctrl+e", title: "editor", selection: "required", onTrigger: act("editor") })
    const chosen = await dialog.select<string>({ title: "File links", placeholder: "Filter links", options, actions })
    if (typeof chosen === "string") await handleLink(chosen)
  }

  if (typeof ctx.keymap?.layer === "function") {
    try {
      ctx.keymap.layer(() => ({
        commands: [
          {
            id: "filelink.links",
            title: "File links in this session",
            description: "Reveal, open or edit a local file linked in this session",
            group: "Session",
            palette: true,
            slash: { name: "links", aliases: ["files"] },
            ...(config.keybind ? { bind: config.keybind } : {}),
            run: () => {
              openLinksDialog().catch((err) => log(`/links failed: ${(err as Error)?.message}`))
            },
          },
        ],
      }))
    } catch (err) {
      log(`could not register /links: ${(err as Error)?.message}`)
    }
  } else {
    log("keymap API unavailable: /links not registered")
  }

  log(`tui ready (platform ${platform}, project ${projectDir}, intercept ${interceptor.installed})`)
  return {
    config,
    interceptor,
    handleLink,
    sessionLinks,
    openLinksDialog,
    cleanup: () => {
      if (warnTimer) clearTimeout(warnTimer)
      interceptor.uninstall()
    },
  }
}

const plugin: PluginDefinition<TuiContext> = {
  id: PLUGIN_ID,
  async setup(ctx) {
    try {
      const handle = setupTui(ctx)
      return () => handle.cleanup()
    } catch (err) {
      try {
        createLogger("tui")(`setup failed: ${(err as Error)?.stack ?? String(err)}`)
      } catch {
        // ignore
      }
      return undefined
    }
  },
}

export default plugin

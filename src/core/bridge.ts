import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Action } from "../types.js"

export interface BridgeRequest {
  readonly path: string
  readonly line?: number
  readonly action?: Action
}

export interface BridgeHandlerResult {
  readonly ok: boolean
  readonly message: string
}

export interface BridgeOptions {
  /** 0 (default) picks a random free port. */
  readonly port?: number
  /** Defaults to 32 random bytes, base64url. */
  readonly token?: string
  readonly handler: (req: BridgeRequest) => Promise<BridgeHandlerResult>
  /** Max accepted /open requests per second (default 10). */
  readonly rateLimitPerSecond?: number
  readonly log?: (msg: string) => void
}

export interface Bridge {
  readonly port: number
  readonly origin: string
  /** Do not log this. */
  readonly token: string
  /** Bridge URL that performs `action` (or the configured default) on `path`. */
  url(path: string, opts?: { line?: number; action?: Action }): string
  /** Regex matching bridge URLs for this instance (global flag). */
  urlPattern(): RegExp
  close(): Promise<void>
}

const HOST = "127.0.0.1"
const ACTIONS = new Set(["reveal", "open", "editor"])

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export function renderPage(ok: boolean, message: string, nonce: string): string {
  const title = ok ? "Done" : "Could not open link"
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>opencode-filelink: ${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1rem;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}}.err{color:#c33}small{opacity:.7}</style></head>
<body><p class="${ok ? "ok" : "err"}">${escapeHtml(message)}</p><p><small>You can close this tab.</small></p>
<script nonce="${nonce}">setTimeout(function(){window.close()},${ok ? 800 : 5000})</script></body></html>
`
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function send(res: ServerResponse, status: number, ok: boolean, message: string): void {
  const nonce = randomBytes(16).toString("base64")
  const body = renderPage(ok, message, nonce)
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  })
  res.end(res.req.method === "HEAD" ? undefined : body)
}

/** Start the localhost bridge. Binds 127.0.0.1 only. */
export function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const token = opts.token ?? randomBytes(32).toString("base64url")
  const limit = opts.rateLimitPerSecond ?? 10
  let windowStart = 0
  let windowCount = 0
  let port = 0

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`])
    const host = (req.headers.host ?? "").toLowerCase()
    if (!allowedHosts.has(host)) return send(res, 403, false, "Forbidden host")
    const origin = req.headers.origin
    if (origin !== undefined && origin !== "null" && !allowedHosts.has(origin.replace(/^http:\/\//, "").toLowerCase())) {
      return send(res, 403, false, "Forbidden origin")
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD")
      return send(res, 405, false, "Method not allowed")
    }
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`)
    if (url.pathname !== "/open" && url.pathname !== "/o") return send(res, 404, false, "Not found")

    const now = Date.now()
    if (now - windowStart >= 1000) {
      windowStart = now
      windowCount = 0
    }
    if (++windowCount > limit) return send(res, 429, false, "Too many requests")

    const t = url.searchParams.get("t") ?? ""
    if (!tokenEquals(t, token)) return send(res, 403, false, "Invalid or missing token")

    const path = url.searchParams.get("path") ?? url.searchParams.get("p")
    if (!path) return send(res, 400, false, "Missing path parameter")
    const lineRaw = url.searchParams.get("line") ?? url.searchParams.get("l")
    const actionRaw = url.searchParams.get("action") ?? url.searchParams.get("a")
    let line: number | undefined
    if (lineRaw) {
      line = Number(lineRaw)
      if (!Number.isInteger(line) || line < 1) return send(res, 400, false, "Invalid line parameter")
    }
    if (actionRaw && !ACTIONS.has(actionRaw)) return send(res, 400, false, "Invalid action parameter")
    try {
      const result = await opts.handler({
        path,
        ...(line !== undefined ? { line } : {}),
        ...(actionRaw ? { action: actionRaw as Action } : {}),
      })
      return send(res, result.ok ? 200 : 422, result.ok, result.message)
    } catch (err) {
      return send(res, 500, false, `Error: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        res.destroy()
      } catch {
        // ignore
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, HOST, () => {
      server.off("error", reject)
      port = (server.address() as AddressInfo).port
      const origin = `http://${HOST}:${port}`
      opts.log?.(`bridge listening on ${origin}`)
      resolve({
        port,
        origin,
        token,
        url(path, o = {}) {
          const q = new URLSearchParams({ path })
          if (o.line !== undefined) q.set("line", String(o.line))
          if (o.action) q.set("action", o.action)
          q.set("t", token)
          return `${origin}/open?${q.toString()}`
        },
        urlPattern() {
          return new RegExp(`https?://(?:127\\.0\\.0\\.1|localhost):${port}/o(?:pen)?\\?[^\\s)>\\]"']*`, "g")
        },
        close() {
          return new Promise<void>((r) => {
            server.close(() => r())
            server.closeAllConnections?.()
          })
        },
      })
    })
  })
}

/** Extract `path` (and `line`) from a bridge URL; used to turn bridge links back into plain paths. */
export function bridgeUrlToPath(url: string): string | undefined {
  try {
    const u = new URL(url.replace(/&amp;/g, "&"))
    const p = u.searchParams.get("path") ?? u.searchParams.get("p")
    if (!p) return undefined
    const line = u.searchParams.get("line") ?? u.searchParams.get("l")
    return line ? `${p}:${line}` : p
  } catch {
    return undefined
  }
}

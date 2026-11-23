import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { request } from "node:http"
import { type Bridge, type BridgeRequest, bridgeUrlToPath, escapeHtml, renderPage, startBridge } from "../src/core/bridge.js"

let bridge: Bridge
const seen: BridgeRequest[] = []

beforeAll(async () => {
  bridge = await startBridge({
    rateLimitPerSecond: 1000,
    handler: async (req) => {
      seen.push(req)
      if (req.path === "boom") throw new Error("kaboom")
      return req.path === "missing.md"
        ? { ok: false, message: "File not found: missing.md" }
        : { ok: true, message: `Revealed ${req.path}` }
    },
  })
})
afterAll(async () => {
  await bridge.close()
})

/** Raw request with full control over the Host/Origin headers. */
function raw(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: bridge.port, path, method, headers }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (c) => {
        body += c
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("bridge", () => {
  test("binds 127.0.0.1 and builds URLs", () => {
    expect(bridge.origin).toBe(`http://127.0.0.1:${bridge.port}`)
    expect(bridge.token.length).toBeGreaterThanOrEqual(40)
    const url = new URL(bridge.url("docs/my report.md", { line: 4, action: "editor" }))
    expect(url.pathname).toBe("/open")
    expect(url.searchParams.get("path")).toBe("docs/my report.md")
    expect(url.searchParams.get("line")).toBe("4")
    expect(url.searchParams.get("action")).toBe("editor")
    expect(url.searchParams.get("t")).toBe(bridge.token)
  })

  test("valid request performs the action and returns a self-closing page", async () => {
    const res = await fetch(bridge.url("docs/report.md", { line: 3 }))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("Revealed docs/report.md")
    expect(body).toContain("window.close()")
    expect(body).toContain("You can close this tab.")
    expect(res.headers.get("cache-control")).toBe("no-store")
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(body).toContain(`<script nonce="${nonce}">`)
    expect(seen.at(-1)).toEqual({ path: "docs/report.md", line: 3 })
  })

  test("short form /o?p=&l=&a= is accepted", async () => {
    const res = await fetch(`${bridge.origin}/o?p=${encodeURIComponent("a b.md")}&l=2&a=open&t=${bridge.token}`)
    expect(res.status).toBe(200)
    expect(seen.at(-1)).toEqual({ path: "a b.md", line: 2, action: "open" })
  })

  test("localhost host header is accepted", async () => {
    const res = await raw(`/open?path=x&t=${bridge.token}`, { Host: `localhost:${bridge.port}` })
    expect(res.status).toBe(200)
  })

  test("bad or missing token is rejected", async () => {
    const n = seen.length
    expect((await fetch(`${bridge.origin}/open?path=x&t=wrong`)).status).toBe(403)
    expect((await fetch(`${bridge.origin}/open?path=x`)).status).toBe(403)
    expect((await fetch(`${bridge.origin}/open?path=x&t=${bridge.token}x`)).status).toBe(403)
    expect(seen.length).toBe(n)
  })

  test("foreign Host header is rejected (DNS rebinding)", async () => {
    const res = await raw(`/open?path=x&t=${bridge.token}`, { Host: `evil.example:${bridge.port}` })
    expect(res.status).toBe(403)
    expect(res.body).toContain("Forbidden host")
    const res2 = await raw(`/open?path=x&t=${bridge.token}`, { Host: "127.0.0.1:1" })
    expect(res2.status).toBe(403)
  })

  test("foreign Origin is rejected", async () => {
    const res = await raw(`/open?path=x&t=${bridge.token}`, { Host: `127.0.0.1:${bridge.port}`, Origin: "https://evil.example" })
    expect(res.status).toBe(403)
    const ok = await raw(`/open?path=x&t=${bridge.token}`, { Host: `127.0.0.1:${bridge.port}`, Origin: bridge.origin })
    expect(ok.status).toBe(200)
  })

  test("only GET/HEAD", async () => {
    const res = await raw(`/open?path=x&t=${bridge.token}`, { Host: `127.0.0.1:${bridge.port}` }, "POST")
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe("GET, HEAD")
    const before = seen.length
    const head = await raw(`/open?path=head-only.md&t=${bridge.token}`, { Host: `127.0.0.1:${bridge.port}` }, "HEAD")
    expect(head.status).toBe(200)
    expect(head.body).toBe("")
    // HEAD (link previews, prefetchers) never performs the action
    expect(seen.length).toBe(before)
    expect(seen.some((r) => r.path === "head-only.md")).toBe(false)
  })

  test("Origin: null (sandboxed frames, data: pages) is rejected", async () => {
    const res = await raw(`/open?path=x&t=${bridge.token}`, { Host: `127.0.0.1:${bridge.port}`, Origin: "null" })
    expect(res.status).toBe(403)
    const https = await raw(`/open?path=x&t=${bridge.token}`, {
      Host: `127.0.0.1:${bridge.port}`,
      Origin: `https://127.0.0.1:${bridge.port}`,
    })
    expect(https.status).toBe(403)
  })

  test("fetch metadata: cross-site and non-navigation requests are rejected (CSRF)", async () => {
    const host = { Host: `127.0.0.1:${bridge.port}` }
    const path = `/open?path=csrf.md&t=${bridge.token}`
    const before = seen.length
    for (const site of ["cross-site", "same-site"]) {
      expect((await raw(path, { ...host, "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate" })).status).toBe(403)
    }
    for (const mode of ["no-cors", "cors", "same-origin", "websocket"]) {
      expect((await raw(path, { ...host, "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": mode })).status).toBe(403)
    }
    expect(seen.length).toBe(before)
    // A link opened from the terminal / another app: top-level navigation, Sec-Fetch-Site none.
    const ok = await raw(path, { ...host, "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" })
    expect(ok.status).toBe(200)
    expect(seen.at(-1)?.path).toBe("csrf.md")
  })

  test("parameter validation", async () => {
    expect((await fetch(`${bridge.origin}/open?t=${bridge.token}`)).status).toBe(400)
    expect((await fetch(`${bridge.origin}/open?path=x&line=0&t=${bridge.token}`)).status).toBe(400)
    expect((await fetch(`${bridge.origin}/open?path=x&line=abc&t=${bridge.token}`)).status).toBe(400)
    expect((await fetch(`${bridge.origin}/open?path=x&action=rm&t=${bridge.token}`)).status).toBe(400)
    expect((await fetch(`${bridge.origin}/other?t=${bridge.token}`)).status).toBe(404)
    expect((await fetch(`${bridge.origin}/`)).status).toBe(404)
  })

  test("handler failures are shown and escaped", async () => {
    const res = await fetch(bridge.url("missing.md"))
    expect(res.status).toBe(422)
    expect(await res.text()).toContain("File not found: missing.md")
    const boom = await fetch(bridge.url("boom"))
    expect(boom.status).toBe(500)
    expect(await boom.text()).toContain("kaboom")
  })

  test("urlPattern matches its own URLs", () => {
    const text = `see [r](${bridge.url("docs/r.md")}) and http://127.0.0.1:1/open?path=x`
    const matches = text.match(bridge.urlPattern())
    expect(matches).toEqual([bridge.url("docs/r.md")])
  })

  test("rate limiting", async () => {
    const limited = await startBridge({ rateLimitPerSecond: 2, handler: async () => ({ ok: true, message: "ok" }) })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) statuses.push((await fetch(limited.url("x"))).status)
      expect(statuses).toEqual([200, 200, 429, 429])
    } finally {
      await limited.close()
    }
  })

  test("fixed port and custom token; port in use rejects", async () => {
    const a = await startBridge({ port: 0, token: "secret-token", handler: async () => ({ ok: true, message: "ok" }) })
    try {
      expect(a.url("x")).toContain("t=secret-token")
      await expect(startBridge({ port: a.port, handler: async () => ({ ok: true, message: "" }) })).rejects.toThrow()
    } finally {
      await a.close()
    }
  })
})

describe("bridge helpers", () => {
  test("escapeHtml", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe("&#60;script&#62;&#34;x&#34; &#38; &#39;y&#39;&#60;/script&#62;")
  })
  test("renderPage escapes the message", () => {
    const html = renderPage(false, "<img src=x onerror=alert(1)>", "n0nce")
    expect(html).not.toContain("<img")
    expect(html).toContain('<script nonce="n0nce">')
  })
  test("bridgeUrlToPath", () => {
    expect(bridgeUrlToPath("http://127.0.0.1:5/open?path=docs%2Fa.md&t=x")).toBe("docs/a.md")
    expect(bridgeUrlToPath("http://127.0.0.1:5/o?p=a.go&l=4&t=x")).toBe("a.go:4")
    expect(bridgeUrlToPath("http://127.0.0.1:5/open?path=a.md&amp;line=2&amp;t=x")).toBe("a.md:2")
    expect(bridgeUrlToPath("http://127.0.0.1:5/open?t=x")).toBeUndefined()
    expect(bridgeUrlToPath("not a url")).toBeUndefined()
  })
})

import type { RendererLike } from "../types.js"

type GetLinkAt = (this: unknown, x: number, y: number) => string | null | undefined

const MARK = Symbol.for("opencode-filelink.getLinkAt")

interface MarkedWrapper extends GetLinkAt {
  [MARK]?: { previous: GetLinkAt; hadOwn: boolean }
}

export interface InterceptOptions {
  /** Return true for hrefs the plugin handles (local files). */
  readonly shouldIntercept: (url: string) => boolean
  /** Called asynchronously (microtask) for intercepted links. */
  readonly onLink: (url: string) => void
  readonly log?: (msg: string) => void
}

export interface InterceptHandle {
  readonly installed: boolean
  readonly reason?: string
  uninstall(): void
}

/**
 * Wrap `renderer.getLinkAt` (opencode 2.2.0 TUI calls it from its global
 * mouse-up handler, then hands the URL to an http(s)-only opener). Local file
 * links are swallowed (return null) and handled by `onLink`; everything else
 * passes through unchanged. Chains politely with other wrappers.
 */
export function installLinkInterceptor(renderer: RendererLike | undefined, opts: InterceptOptions): InterceptHandle {
  const noop: InterceptHandle = { installed: false, uninstall() {} }
  if (!renderer || (typeof renderer !== "object" && typeof renderer !== "function")) {
    return { ...noop, reason: "no renderer on the TUI plugin context" }
  }
  let current = renderer.getLinkAt as MarkedWrapper | undefined
  if (typeof current !== "function") {
    return { ...noop, reason: "renderer.getLinkAt is not available in this opencode version" }
  }
  let hadOwn = Object.hasOwn(renderer, "getLinkAt")
  // A stale wrapper of ours (hot reload without cleanup): unwrap it first.
  const stale = current[MARK]
  if (stale) {
    current = stale.previous
    hadOwn = stale.hadOwn
  }
  const previous = current as GetLinkAt
  let active = true

  const wrapper: MarkedWrapper = function (this: unknown, x: number, y: number) {
    const url = previous.call(this, x, y)
    if (!active || typeof url !== "string" || url === "") return url
    let intercept = false
    try {
      intercept = opts.shouldIntercept(url)
    } catch (err) {
      opts.log?.(`shouldIntercept failed: ${(err as Error)?.message}`)
    }
    if (!intercept) return url
    queueMicrotask(() => {
      try {
        opts.onLink(url)
      } catch (err) {
        opts.log?.(`link handler failed: ${(err as Error)?.message}`)
      }
    })
    return null
  }
  wrapper[MARK] = { previous, hadOwn }

  try {
    ;(renderer as Record<string, unknown>).getLinkAt = wrapper
  } catch (err) {
    return { ...noop, reason: `cannot patch renderer.getLinkAt: ${(err as Error)?.message}` }
  }

  return {
    installed: true,
    uninstall() {
      active = false
      if (renderer.getLinkAt !== wrapper) return // someone wrapped on top of us; stay inert in the chain
      try {
        if (hadOwn) (renderer as Record<string, unknown>).getLinkAt = previous
        else delete (renderer as Record<string, unknown>).getLinkAt
      } catch {
        // leave the inert wrapper in place
      }
    },
  }
}

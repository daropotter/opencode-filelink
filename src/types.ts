/**
 * Minimal structural types for the parts of the opencode 2.x plugin API that
 * this plugin uses. They mirror `@opencode/plugin` 2.2.0 (`Plugin.Context`,
 * `tui` `Context`) but are declared locally so the package has no build-time
 * dependency on the SDK (which pulls in effect, solid, opentui, ...).
 * Every member is optional where the host might not provide it, because the
 * plugin feature-detects instead of trusting the shape.
 */

export type Action = "reveal" | "open" | "editor"

export interface LocationLike {
  readonly directory?: string
  readonly project?: { readonly directory?: string }
}

/** Server-side `Plugin.Context` (subset). */
export interface ServerContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly location?: LocationLike
  readonly tool?: {
    transform?: (cb: (editor: ToolEditorLike) => void) => Promise<unknown>
  }
  readonly session?: {
    hook?: (name: string, cb: (input: any) => void | Promise<void>) => Promise<unknown>
  }
}

export interface ToolEditorLike {
  add(tool: ToolInfo): void
  get?(id: string): unknown
  remove?(id: string): void
}

export interface ToolResult {
  output?: string
  metadata?: Record<string, unknown>
}

export interface ToolInfo {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context?: unknown) => Promise<ToolResult>
}

export interface PluginDefinition<Ctx> {
  readonly id: string
  readonly setup: (ctx: Ctx) => Promise<(() => void | Promise<void>) | undefined>
}

/** `@opentui/core` `CliRenderer` (subset). */
export interface RendererLike {
  getLinkAt?: (x: number, y: number) => string | null | undefined
  [key: string]: unknown
}

export interface DialogSelectOption<V> {
  readonly title: string
  readonly value: V
  readonly description?: string
  readonly footer?: string
}

export interface DialogSelectAction<V> {
  readonly bind: string
  readonly title: string
  readonly selection?: "required"
  readonly onTrigger: (value: V) => void
}

export interface KeymapCommand {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly slash?: { readonly name: string; readonly aliases?: string[] }
  readonly bind?: string | false
  readonly run: (input?: string) => void | false | Promise<void>
}

export interface TextContentLike {
  readonly type: string
  readonly text?: string
}

export interface SessionMessageLike {
  readonly type: string
  readonly id?: string
  readonly content?: readonly TextContentLike[] | unknown
  readonly text?: string
}

/** TUI `Context` (subset). */
export interface TuiContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly location?: LocationLike
  readonly renderer?: RendererLike
  readonly data?: {
    readonly session?: {
      get?(id: string): { readonly location?: LocationLike } | undefined
      readonly message?: {
        list?(sessionID: string): readonly SessionMessageLike[]
        sync?(sessionID: string): Promise<void>
      }
    }
    readonly location?: { default?(): LocationLike | undefined }
  }
  readonly keymap?: {
    layer?(factory: () => { mode?: string; priority?: number; commands?: readonly KeymapCommand[] }): void
  }
  readonly ui?: {
    readonly toast?: {
      show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }): void
    }
    readonly dialog?: {
      select?<V>(options: {
        title: string
        placeholder?: string
        options: readonly DialogSelectOption<V>[]
        actions?: readonly DialogSelectAction<V>[]
      }): Promise<V | undefined>
      clear?(): void
    }
    readonly router?: { current?(): { type: string; sessionID?: string } }
  }
}

# @daropotter/opencode-filelink: design and spike findings

Status: spike complete (2026-11-23). Target: opencode 2.2.0 (`/home/daro/.opencode/bin/opencode`, Bun-compiled, embedded Bun 1.4.4).
Spike artefacts (throwaway): `/tmp/claude-1000/-home-daro-work-opencode-filelink/d49e04fc-e53d-47a9-8d7e-97bd0e2dfeac/scratchpad/proj/spike/{server.js,tui.tsx}` and the pty driver `.../scratchpad/drive.py`.

## 1. Summary

| Path | Feasible in 2.2.0? | Evidence |
|---|---|---|
| **A. TUI plugin intercepts link clicks** | **Yes, verified end-to-end.** | Wrapping `ctx.renderer.getLinkAt` on the TUI plugin context intercepts the click before the TUI calls `openUrl`. With the patch the "Only http and https links…" toast does not appear; without it, it does (control run). |
| **B. Server plugin + localhost bridge** | Bridge, tool and HMAC links: yes. **Rewriting the assistant's text: no clean hook.** | 2.x removed `experimental.text.complete` (0 occurrences in the binary). The only session hooks are `prompt, context, compaction, generate, title, model.request, http.request, http.response, experimental.ws.*, retry`. No API edits a message part. |
| Agent tool `open_file` / `reveal_file` | Yes, verified (registered via `ctx.tool.transform`). | spike log: `[server] tool registered` |
| `/links` command + keybind | Yes, verified (`ctx.keymap.layer` + `dispatch`). `/open` is already taken by a built-in (see 5.4). | spike log: `commands has filelink.open true`, `slash run` |
| Desktop app (GUI) | Native path exists: GUI plugins can contribute a `LinkHandler` (`@opencode/plugin/gui`). A bridge is not needed there. | `dist/gui/registries.d.ts` `Link`, `LinkHandler`; `host-apis.d.ts` `Links` |

Recommendation: ship **A** as the main path. Ship **B** as the bridge, the agent tool and an *opt-in* link rewrite. Plan a later **GUI `LinkHandler`** for the desktop app.

## 2. Plugin declaration and loading (opencode 2.x)

### 2.1 SDK packages
- **2.x uses `@opencode/plugin`** (npm latest 2.4.0; 2.2.0 matches the binary). It has these entry points: `.` (promise API), `./effect`, `./tui`, `./gui`, `./host`, `./runtime`.
- `@opencode-ai/plugin` (1.17.11 installed; 1.19.6 latest, **byte-identical `dist`**) is the **1.x** API: `server(input) => Hooks`, `experimental.text.complete` and so on. 2.x rejects a plain function default export with `"Plugin must export default definition id effect or setup function."`. Its `dist/v2/**` is an older draft of the v2 API. Do not use it.
- The user's `opencode-browser#support-opencode-v2` (cached at `~/.cache/opencode/npm/git-opencode-browser-24c7a96dba4c/…`) uses a dual default export, `{ id, setup, server }`. 2.x reads `id`+`setup` and 1.x calls `server`. It imports only types (`import type … from "@opencode/plugin/promise/plugin"`).

### 2.2 Config
`~/.config/opencode/opencode.json` (global) or `<project>/opencode.json`, key **`plugins`** (array):
```jsonc
"plugins": [
  "github:daropotter/opencode-browser#support-opencode-v2",   // string spec: npm, github:, ./local, /abs, file://
  { "package": "@daropotter/opencode-filelink", "options": { "action": "reveal" } }
]
```
- Options use the **object form `{ package, options }`**. The tuple form `["pkg", {…}]` is rejected. Log from the spike: `configuration normalization diagnostic … path=$.plugins.0 kind=invalid action="skipped malformed recognized value"`. Schema: `@opencode/schema/config/plugin` `Entry { package: string; options?: Record<string, unknown> }`.
- npm and git specs are installed into `~/.cache/opencode/npm/<name>/<ts>/node_modules/…`. Local specs (`./x`, `../x`, absolute, `file://`) resolve against the config's directory and are **file-watched with hot reload**.

### 2.3 How server and TUI parts are distinguished
`@opencode/plugin/dist/host.js` `Host.resolve()`:
```js
server: entry(["server", ""]),   // package exports "./server" or "."  (local dir: server.* / index.*)
tui:    entry(["tui"]),          // package exports "./tui"            (local dir: tui.*)
rpc:    entry(["rpc"]),
gui:    entry(["gui-experimental"])  // prebuilt CJS, desktop app only
```
- A single `plugins` entry provides all parts. There is no separate `tui.json`. The binary only reads `tui.json` to migrate it into `cli.json`.
- The server (`PluginModule.load`) requires a server **or** gui entry (`if(!k) "Plugin entrypoint not found"`). A TUI-only package would fail on the server, so **always ship a server entry**.
- The TUI loads plugins that the server reports as `features.tui===true`, plus `plugins` in `~/.config/opencode/cli.json`, plus discovered plugin directories (e.g. `~/.config/opencode/plugins/*`).
- A TUI module must be `default: { id: string; setup: Function }` (`MDt()` check, otherwise "Invalid V2 TUI plugin module").
- **A failing server-side transform disables the whole plugin, TUI part included.** In the spike, `"disabled plugin after transform failure"` meant the TUI part never loaded.

### 2.4 Options delivery (important)
- Server `ctx.options` = the `options` of the `opencode.json` entry (verified: `{"action":"reveal","hello":1}`).
- **TUI `ctx.options` was `{}`.** The TUI gets server-discovered plugins *without* options (`h().map(… install:false)` in `gLe`). TUI options come only from a `cli.json` `plugins` entry (`{package, options}`, same shape). The plugin list API (`Plugin.Info`) does not expose options either.
- Design consequence: the TUI part uses `ctx.options` (from `cli.json`) merged over the same defaults. The README documents that TUI-side options go into `cli.json`. Later option: an `rpc` export so the TUI can fetch the server's resolved config.

## 3. Runtime

- Both the server and TUI plugins run inside the opencode binary's **Bun 1.4.4** (`typeof Bun` defined; spike: `runtime bun 1.4.4`).
- The host provides `effect`, `@opencode/plugin*`, `@opentui/core`, `@opentui/solid`, `solid-js` and `solid-js/store`. It **refuses** copies of `effect` or `@opencode/plugin` that come from a plugin's own `node_modules`.
- `.tsx` sources are compiled on load with the Solid transform (`opentui.solid.runtime-plugin-support`).
- The TUI part does not need JSX: `ui.dialog.select`, `ui.toast` and `keymap` are all non-JSX. So ship plain ESM JS and skip any JSX build step.
- Use only `node:` built-ins (`node:http`, `node:child_process`, `node:fs`, `node:path`, `node:url`, `node:crypto`). They work under Bun and Node, which keeps the core unit-testable anywhere.

## 4. Server-side API (2.x promise API)

```ts
import type { Plugin } from "@opencode/plugin"          // namespace: Plugin.Plugin, Plugin.Context
// default export shape (validated by the host):
export default { id: "opencode-filelink", setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> }
```
`Plugin.Context` keys (verified at runtime): `app, location, options, agent, aisdk, command, credential, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell`.

- **Project dir:** `ctx.location.directory` and `ctx.location.project.directory` (absolute; verified). Per-session dir: `SessionInfo.location.directory`.
- **Tool registration** (verified). `Tool.Info` uses `name`, not `id`: `e.name.replace` crashed with `id`.
  ```ts
  await ctx.tool.transform((editor) => editor.add({
    name: "open_file",
    description: "Open/reveal a local file for the user (file manager, default app or editor).",
    input: { type: "object", properties: { path: {type:"string"}, line: {type:"integer"}, action: {enum:["reveal","open","editor"]} }, required: ["path"] }, // JSON Schema, Standard Schema or effect Schema
    execute: async (input, toolCtx) => ({ output: "Revealed docs/report.md" }), // Result { output?, content?, metadata? }
    options: { permission: "open_file" }   // optional
  }))
  ```
- **Hooks:** `ctx.session.hook(name, cb)`, where name is one of `prompt | context | compaction | generate | title | model.request | http.request | http.response | experimental.ws.{handshake,send,receive} | retry`. Tool hooks are `ctx.tool.hook("execute.before" | "execute.after", cb)`. `context` exposes a mutable `system: SystemPart[]` and `messages: Message[]` (the 2.x equivalent of `experimental.chat.messages.transform`).
- **Events:** `for await (const ev of ctx.event.subscribe({ signal }))`. These include `session.text.started|delta|ended`. They are read-only, and no client operation edits a message part (`SessionApi` has no part update).
- **Link rewrite options (B)**, since `text.complete` is gone:
  1. `linkRewrite: "prompt"`: the `context` hook appends a system instruction telling the model to write local links as `http://127.0.0.1:PORT/o?p=<urlencoded path>&t=<token>`. The same hook rewrites such URLs back to plain paths in `messages`, so history stays clean. Cost: the bridge token is sent to the LLM provider. That is acceptable because it only authorises localhost reveal/open inside allowed roots, but document it.
  2. `linkRewrite: "stream"` (experimental, off): wrap `http.response`'s `Response.body` with a TransformStream that rewrites text deltas. This is provider-specific (Anthropic/OpenAI SSE shapes), links can be split across chunks, and the rewritten text is persisted. Not recommended for v0.1.
  3. `linkRewrite: "off"` (**default**). The TUI uses A. The bridge serves the tool and on-demand links only.

## 5. TUI plugin API and click interception (A)

### 5.1 How a click is handled today (binary, de-minified names)
- Markdown links: the `@opentui/core` markdown renderer emits chunks with `link: { url: e.href }`, the **raw href**, still percent-encoded (`case"link":{let i={url:e.href};…`).
- The app-root `onMouseUp` (covers the home and session routes, `v = useRenderer()`):
  ```js
  e(Se,"onMouseUp",(we)=>{let rt=tLe(v,we);if(rt)return void G$(rt).catch(B.error);if(Ze())See(we,v,B,xe)})
  function tLe(t,r){if(!r.isDragging||r.modifiers.ctrl||r.modifiers.alt||r.modifiers.shift)return;
    let n=t.getSelection();if(!n?.isStart||n.behavior!=="cell")return;return t.getLinkAt(r.x,r.y)??void 0}
  function G$(e){let r=URL.canParse(e)?new URL(e):void 0;if(!r||r.protocol!=="http:"&&r.protocol!=="https:")
    return Promise.reject(Error(`Only http and https links can be opened in the browser: ${e}`));return D(r.href)}
  function ote(e){return D(e)}             // exported as openPath; D = sindresorhus `open`
  ```
  `getLinkAt` (a `CliRenderer` method in `@opentui/core`: `getLinkIdAt` → `contextGetLinkUrl`) has **exactly one call site**, `tLe`. The `n1` link component calls `G$` directly, but only for app-internal http links.

### 5.2 Interception: wrap `renderer.getLinkAt` (verified)
The TUI plugin context's `renderer` is the same `CliRenderer` instance (`hA`) that the app uses, and the call is a dynamic method lookup. An own-property override therefore wins:
```ts
const r = ctx.renderer
const original = r.getLinkAt                       // keep for restore
r.getLinkAt = function (x: number, y: number) {
  const url = original.call(this, x, y)
  if (url && isLocalFileHref(url)) { queueMicrotask(() => handleLink(url)); return null }  // swallow
  return url                                       // http(s), mailto, etc. untouched
}
return () => { if (r.getLinkAt !== original) delete (r as any).getLinkAt }  // cleanup on unload/hot reload
```
Spike result (pty, SGR mouse press and release on a `<a href="docs/report.md">` rendered in the `home.footer` slot): `getLinkAt called 1 39 docs/report.md` → `INTERCEPT local link docs/report.md`, and no error toast. In the control run without the patch the toast `Only http…` appeared.
- Returning `null` falls through to `if(Ze())See(…)`, the normal non-link click path. This is harmless.
- The patch only fires when `tLe` asks, that is on a plain left-click with no drag or modifiers. Hover and selection are unaffected.
- Robustness: detect the feature with `typeof r.getLinkAt === "function"`. If it is missing, log, show a one-time toast and rely on B. Chain politely if another plugin has already wrapped it.
- Fallback idea, not needed now: `renderer.prependInputHandler` with `hitTest`/`getLinkIdAt` on raw SGR mouse sequences.
- Upstream ask: a TUI `links` and `LinkHandler` API mirroring the GUI one, so the monkey-patch can go.

### 5.3 Other TUI context used (`@opencode/plugin/tui` `Context`, verified keys)
`options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap, storage, ui`.
- Messages: `ctx.data.session.message.list(sessionID)` returns `SessionMessageInfo[]`. Use the `type:"assistant"` entries with `content[].type==="text"`, parse the markdown links, and resolve them against `ctx.data.session.get(id)?.location.directory`, falling back to `ctx.data.location.default().directory`.
- Current session: `ctx.ui.router.current()` returns `{type:"session", sessionID}`.
- UI: `ctx.ui.toast.show({ message, variant })` and `ctx.ui.dialog.select({ title, options, actions })`.
- Recent-links list: `ctx.storage.memory("recent", {initial:{…}})`. Each intercepted click is recorded as well.

### 5.4 Command and keybind
```ts
ctx.keymap.layer(() => ({ commands: [{
  id: "filelink.links", title: "File links in this session", group: "Session",
  slash: { name: "links", aliases: ["files"] }, palette: true,
  bind: options.keybind ?? false,          // e.g. "<leader>o"; user can override via config keybind id
  run: () => openLinksDialog(),
}]}))
```
**`/open` is taken.** It is the built-in "Open session or project" command, with aliases `projects` and `project`. Use **`/links`**. In the dialog, Enter performs the default action and footer actions give reveal / open / editor / copy path.

## 6. Shared core: href parsing and path policy

`isLocalFileHref(href)` returns true when the href is:
- scheme-less: `docs/x.md`, `./x`, `../x`, `/abs`, `~/x`;
- a Windows drive path `C:\x` or `C:/x` (`URL.canParse` treats `C:` as a scheme, so special-case `^[A-Za-z]:[\\/]`);
- a UNC path `\\server\share`;
- `file:` (`file:///abs`, `file://localhost/abs`, `file:///C:/x`).

Leave alone: `http(s):`, `mailto:`, other schemes, and pure anchors `#…`.

Parsing:
1. Strip a `?query`.
2. Take the fragment `#L42`, `#L42C7` or `#L42-L50` as the line and column.
3. `decodeURIComponent`, with a try/catch fallback to the raw string, so `Kredyty%20i%20koszt%20runner%C3%B3w.md` works.
4. If the whole string does not exist, try `:line[:col]` suffixes (`path:42`, `path:42:7`), checking whether the file exists first.
5. Expand `~/` with `os.homedir()`.
6. Resolve relative paths against the session directory.

Policy:
- `fs.realpath` the target and the allowed roots: project/worktree dir, session dir, and `extraRoots`.
- Unless `allowOutsideProject`, require `rel = path.relative(root, real)` to satisfy `!rel.startsWith("..") && !path.isAbsolute(rel)`.
- `~/` and absolute paths outside the roots therefore need `allowOutsideProject: true`.
- The target must exist. If a file is missing but its parent exists, reveal the parent.

## 7. Per-OS commands

Always use `spawn(cmd, args, { shell: false, detached: true, stdio: "ignore" }).unref()` and never a shell string. Commands form a fallback chain. A command marked "waited" must exit 0 to count (a non-zero exit falls through to the next one and the failure is reported); the others count once spawned. The table shows the commands as implemented in v0.1.0 (`src/core/commands.ts`, `src/core/winexe.ts`).

| Action | Linux (desktop) | WSL (`WSL_DISTRO_NAME`, `WSL_INTEROP`, or `microsoft`/`wsl` in `/proc/version`) | macOS | Windows |
|---|---|---|---|---|
| **reveal** | 1. `busctl --user call org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1 ShowItems ass 1 <fileURI> ""` (separate argv items, no escaping issues). 2. `gdbus call --session --dest org.freedesktop.FileManager1 --object-path /org/freedesktop/FileManager1 --method org.freedesktop.FileManager1.ShowItems "['<uri>']" ""` (the URI percent-encodes `'`). 3. `dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 --type=method_call /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:<uri> string:` (`,` encoded as `%2C`). 4. `xdg-open <dirname>`. 5. `gio open <dirname>`. All waited. | `explorer.exe /select,<winpath>`, where `winpath = wslpath -w <abs>` (fallback: `/mnt/c/x` → `C:\x`, else `\\wsl.localhost\<distro>\x`). Not waited (exits 1 on success). | `open -R <path>` (waited) | `%SystemRoot%\explorer.exe /select,"<path>"` with `windowsVerbatimArguments: true`; paths with `"<>\|*?` or control characters are refused. Not waited. |
| **open** (default app) | `xdg-open <path>`, then `gio open <path>` (both waited) | `explorer.exe <winpath>` only. **Not `wslview`**: wslu passes the path to `powershell.exe -Command "Start \"<path>\""`, where `$(...)` or a backtick in a legal file name is evaluated. | `open <path>` (waited) | `%SystemRoot%\explorer.exe "<path>"` (verbatim). A drive or share root is passed as `"<root>."` so the trailing `\` does not escape the quote. **Never `cmd /c start`** and no PowerShell. |
| **editor** (`path:line`) | template argv, e.g. `code -g {file}:{line}:{col}` | same, run on the Linux side with the Linux path | same | same, but the command is resolved to an absolute path first: only absolute `PATH` entries are searched (never the current directory), with `PATHEXT` limited to `.com/.exe/.bat/.cmd`. Batch files are never run (cmd.exe re-parses arguments: BatBadBut; Node >= 20.12 refuses them without a shell). Known Electron shims (`bin\code.cmd`, `code-insiders`, `codium`, `cursor`, `windsurf`) are mapped to the sibling `.exe`, with `resources\app\out\cli.js` and `ELECTRON_RUN_AS_NODE=1` when present, as the shim itself does. Other batch files are refused and the opener falls back to `action` (or `reveal`) with a warning. |

Additional rules in the opener: `open` on an executable-like file (per-platform extension lists: `.exe`, `.bat`, `.ps1`, `.lnk`, `.msi`, ... on Windows and WSL; `.app`, `.command`, `.pkg`, ... on macOS; `.desktop`, `.AppImage`, `.run`, `.jar` on Linux) is turned into `reveal` with a warning. On Linux, when every command fails and neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, the error message says there is no graphical session.

Reference: `ote()` (the TUI's "Open folder … in system file manager") is just `open(dir)` from sindresorhus `open`. macOS uses `open`. Win32 and WSL use PowerShell `Start` with `-EncodedCommand`, plus `wslpath` on WSL. Linux uses `xdg-open` (bundled or system). It opens the folder **without selecting** the file, so the reveal commands above are better. The plugin does not use PowerShell at all.

Editor templates are argv arrays with placeholders `{file} {line} {col} {dir}`, substituted per element. Elements are never joined or re-split:
`vscode: ["code","-g","{file}:{line}:{col}"]`, `cursor: ["cursor","-g",…]`, `zed: ["zed","{file}:{line}:{col}"]`, `idea: ["idea","--line","{line}","--column","{col}","{file}"]`, `subl: ["subl","{file}:{line}:{col}"]`.
Terminal editors (`nvim +{line} {file}`) would fight the TUI for the terminal. Implemented: they are rejected with a hint to wrap them in a terminal window (`kitty -e nvim +{line} {file}`).

## 8. Config schema (proposal)

The same object is used for the server (`opencode.json`) and the TUI (`cli.json`). Validate it with a small hand-written validator and warn on unknown keys.
```ts
interface FilelinkOptions {
  action?: "reveal" | "open" | "editor"          // default "reveal" (plain click)
  lineAction?: "editor" | "reveal" | "open"      // when the link has :line / #L42; default "editor" if editor set, else action
  editor?: string[] | "vscode" | "cursor" | "zed" | "idea" | "subl"   // argv template or preset; default unset
  allowOutsideProject?: boolean                  // default false (applies to abs, ~/, file://)
  extraRoots?: string[]                          // additional allowed roots; default []
  intercept?: boolean                            // TUI: patch getLinkAt; default true
  toast?: boolean                                // TUI: success toast; default true (errors always shown)
  keybind?: string | false                       // TUI: /links keybind; default false
  bridge?: { enabled?: boolean; port?: number; host?: "127.0.0.1" }  // default { enabled: true, port: 0 (random) }
  linkRewrite?: "off" | "prompt" | "stream"      // server; default "off"
  tool?: boolean                                 // register open_file/reveal_file; default true
}
```

## 9. Bridge (B) and security

- Use `node:http` `createServer().listen(port ?? 0, "127.0.0.1")`. Never bind `0.0.0.0` or `::`.
- Use one instance per server process, shared across locations (lazy start; close in the cleanup).
- Endpoint: `GET /o?p=<path>&l=<line>&a=<action>&s=<sig>`.
  - `sig = base64url(HMAC-SHA256(secret, p|l|a))` with `secret = randomBytes(32)` per process. Signed links cannot be retargeted to another path.
  - Prompt mode needs model-written URLs, so it uses a separate per-process token `t=`, compared with `crypto.timingSafeEqual`.
- Reject requests unless `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding). Reject a non-null `Origin` that is not the bridge itself. Only GET is allowed. Add simple per-second rate limiting.
- Run the same parse and policy as §6 (realpath, roots, existence) and the same spawn-only executor as §7.
- Response: a tiny HTML page with `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'` and `Cache-Control: no-store`. Its body is the result, then `window.close()`. Browsers only close script-opened tabs, so show "You can close this tab" as a fallback.
- Log the bridge URL (port) at startup; never log the secret.
- Caveat: with the default **background service** (`opencode` without `--standalone`), the server process may lack `DISPLAY`, `WAYLAND_DISPLAY` or `DBUS_SESSION_BUS_ADDRESS`, or may run on another machine. The executor must report spawn failures clearly. Path A runs in the TUI process, where the user actually is, so it does not have this problem.

## 10. Project layout, build, test

```
package.json      name @daropotter/opencode-filelink, type: module,
                  exports: { ".": {types,import: "./dist/server.js"}, "./server": same, "./tui": {types,import:"./dist/tui.js"} },
                  files: ["dist"], peerDependencies: { "@opencode/plugin": ">=2.2.0" } (optional),
                  devDependencies: @opencode/plugin@2.2.0, effect@4 beta (types), typescript, @types/bun
src/
  server.ts       default { id: "opencode-filelink", setup }  – tool, bridge, optional rewrite hooks
  tui.ts          default { id: "opencode-filelink", setup }  – getLinkAt patch, /links, toasts
  core/href.ts    isLocalFileHref, parseHref (line/col, %-decode, file://, ~, drive letters)
  core/policy.ts  resolve + realpath + root containment
  core/platform.ts detectPlatform(): "linux" | "wsl" | "darwin" | "win32"
  core/commands.ts buildCommands(action, platform, target, opts) -> Array<{cmd, args, opts}> (pure, testable)
  core/exec.ts    spawn with fallback chain (injectable spawner)
  core/bridge.ts  http server, HMAC, HTML page
  core/links.ts   extract markdown links from message text
test/*.test.ts
```
- **Build:** `tsc -p tsconfig.build.json` (ESM, `declaration: true`, target ES2022, `module`/`moduleResolution`: `NodeNext` or `Bundler`, `verbatimModuleSyntax`). Use type-only imports of `@opencode/plugin`, so `dist` has zero runtime dependencies. No bundler is needed.
- **Tests:** `bun test`, since the plugins run on Bun.
  - Core modules are pure functions, so they are table-tested per OS by injecting the `platform` and the spawner.
  - The bridge is tested with real `fetch` against `127.0.0.1:0`.
  - The TUI patch is tested with a fake renderer object.
- **Smoke test:** a pty script driving `opencode --standalone` with a project-local `opencode.json` that points at the repo (see the spike's `drive.py`). It sends SGR mouse sequences `\e[<0;X;YM` / `\e[<0;X;Ym` and checks the plugin's log and the absence of "Only http".
- **Optional:** a 1.x compatibility key `server` (1.x has `experimental.text.complete`, which allows real rewriting there). This is out of scope for v0.1.

## 11. Open risks

1. **The A monkey-patch relies on internals.** It depends on the TUI calling `renderer.getLinkAt` from its global mouse-up handler. That is a public `CliRenderer` method, but the call site is internal. Mitigation: feature-detect, keep the B fallback, and pursue an upstream TUI `LinkHandler` API.
2. **No server text-transform hook in 2.x.** The bridge links in the chat depend on prompt mode (token goes to the provider, and the model must comply) or on fragile stream rewriting. The default is off.
3. **TUI options live in `cli.json`**, separate from `opencode.json`. Users must configure them twice, or later via RPC.
4. **Terminal OSC 8 hyperlinks:** terminals with hyperlink support may expose the raw relative href to their own Ctrl/Cmd+click, which the plugin cannot affect.
5. **Background service environment:** server-side opens may run without a display or session bus, or on a remote host. See §9.
6. **Windows:** explorer `/select` quoting and the `.cmd` editor shims need testing on real Windows. So does WSL with `\\wsl.localhost` paths.
7. **Untested here:** the slash command typed into the prompt. Registration and `dispatch` are verified; typing `/open-spi` + Tab + Enter did not log a run in the pty, probably a completion-popup timing issue. The relative-href resolution base (session location directory vs. TUI cwd) also needs confirming with a real assistant message.

## 12. Implementation notes (v0.1.0)

What the implementation does where it differs from, or refines, the proposal above.

- **Layout.** `src/config.ts` (not `core/config.ts`), plus `core/editor.ts`, `core/opener.ts` (resolve → choose action → build commands → run), `core/intercept.ts` (the `getLinkAt` wrapper), `core/log.ts` and `core/runtime.ts`. `src/types.ts` declares minimal structural types for the host APIs, so there is no build-time dependency on `@opencode/plugin` (its dependency tree includes effect, opentui, solid and vite/electron peers). It is an optional `peerDependency`.
- **Config resolver.** Both parts call `loadConfig()`: defaults < global `$OPENCODE_CONFIG_DIR` or `$XDG_CONFIG_HOME/opencode` (`opencode.json`, `opencode.jsonc`, `cli.json`, `cli.jsonc`) < `$OPENCODE_CONFIG` < project files (`opencode.json(c)` and `.opencode/opencode.json(c)`, from the git root down to the location directory; only the location directory without a git root) < `ctx.options`. Entries match on the package name (optionally `@version` or `npm:`), `github:`/git specs ending in `opencode-filelink`, or a local path whose `package.json` name is ours. Both `plugins` and legacy `plugin` keys and the tuple form are read. Invalid values are dropped with a warning.
- **Options implemented:** `action` (`"reveal"`), `lineAction` (unset: `"editor"` when an editor is available, else `action`), `editor` (preset name, template string or argv array), `editorFromEnv` (`false`; `$VISUAL`/`$EDITOR`, terminal editors skipped), `allowOutsideProject` (`false`), `extraRoots` (`[]`), `intercept` (`true`), `toast` (`true`), `keybind` (`false`), `bridge` (`{ enabled: true, port: 0 }`, or a boolean), `linkRewrite` (`"off"` | `"instruct"`), `tools` (`true`). `linkRewrite: "stream"` was not implemented.
- **Path policy.** Every candidate path is checked against the allowed roots (session/location directory, project directory, `extraRoots`, both as written and symlink-resolved) *before* any file system access, so nothing outside is probed and an outside path is reported as "outside the project" even when it does not exist. The `realpath` result is checked again (symlinks). Under Windows path rules, network and device paths (`\\server\share`, `\\?\…`, `\\.\…`) are refused even with `allowOutsideProject` unless inside `extraRoots`, because a stat of a share can send NTLM credentials to that host.
- **Missing files** (inside the roots) always produce a "File not found" error toast. The parent is not revealed.
- **Links not intercepted:** besides schemes and anchors, scheme-less web addresses (`www.example.com`, `127.0.0.1:8080/x`) and anything containing control characters.
- **Executable-like files.** `open` on scripts, installers, shortcuts or app bundles is turned into `reveal` with a warning (TUI warning toast, `Note:` line in tool output), whether the request comes from a click, a tool or the bridge.
- **Directories:** `reveal` selects the directory in its parent (DBus `ShowItems` / `open -R` / `explorer /select`). `open` opens it in the file manager.
- **Linux reveal chain:** `busctl` → `gdbus` → `dbus-send --print-reply` → `xdg-open <parent>` → `gio open <parent>`. All of them, and `xdg-open`/`gio` for `open` and macOS `open`, wait for exit (4 s timeout, then assumed fine); a non-zero exit falls through and the final failure is reported, with a no-graphical-session hint when `DISPLAY` and `WAYLAND_DISPLAY` are unset. Commands that are not waited for (`explorer.exe`, editors) count as successful once spawned, or after 1.5 s without `spawn`/`error`.
- **Windows.** `explorer.exe` is run as `%SystemRoot%\explorer.exe`. Editor commands are resolved to an absolute `.exe` (`src/core/winexe.ts`); batch files are never executed, VS Code-family shims are mapped to their `.exe`, and an unusable editor falls back to the plain action with a warning. WSL `open` uses `explorer.exe` only (no `wslview`, see §7).
- **Bridge:** `GET /open?path=&line=&action=&t=` (also `/o?p=&l=&a=`). It uses a per-process token only, without per-link HMAC. Checks, in order: `Host` is `127.0.0.1:<port>` or `localhost:<port>`; `Origin`, when present, must be the bridge's own (`null` is refused); fetch metadata, when present, must be `Sec-Fetch-Site: none|same-origin` and `Sec-Fetch-Mode: navigate`; method `GET`/`HEAD`; path. `HEAD` returns a page without performing anything. Then the 10 requests/s limit and the constant-time token check. The tool output includes a bridge URL only with `linkRewrite: "instruct"`, so the token reaches the provider only in that mode. `linkRewrite: "instruct"` starts the bridge even if `bridge.enabled` is false. Bridge URLs are rewritten back into plain paths in the `context` hook's `messages`.
- **Install from git.** `dist/` is not committed; a `prepare` script (`tsc -p tsconfig.build.json`) builds it when npm installs the package from a git spec.
- **Keymap mode.** The `/links` layer must use `mode: "global"`. Commands in the default `base` layer can be dispatched but do not appear in the palette or in slash completion. The pty smoke test verified this, which resolves risk 7.
- **Debugging.** `OPENCODE_FILELINK_LOG=<file>` logs both parts to a file. Nothing is written to stderr, which would corrupt the TUI. `OPENCODE_FILELINK_DRY_RUN=1` logs the commands instead of spawning them.
- **Smoke test (2026-11-23, opencode 2.2.0).** A project-local `opencode.json` pointed at the repo path, and a helper TUI plugin rendered `<a>` links. Results: `docs/report.md` → `busctl … ShowItems` (dry-run). `docs/my%20file.md:3` → `code -g …/docs/my file.md:3`. `docs/missing.md` → error toast. `#section` → passed through, and the TUI showed its own "Only http…" toast. `/links` and the palette entry open the dialog, and choosing an item opens it.

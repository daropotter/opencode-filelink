# opencode-filelink

[![npm](https://img.shields.io/npm/v/@daropotter/opencode-filelink.svg)](https://www.npmjs.com/package/@daropotter/opencode-filelink)
[![CI](https://github.com/daropotter/opencode-filelink/actions/workflows/ci.yml/badge.svg)](https://github.com/daropotter/opencode-filelink/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [opencode](https://opencode.ai) 2.x plugin that makes local file links in the TUI clickable. Click `docs/report.md` in an assistant message and the file is shown in your file manager, opened in its default app, or opened in your editor at the right line.

## The problem

Agents often link to files they just wrote or read:

```markdown
See [the report](docs/report.md) and [the handler](src/internal/file.go:42).
```

In the opencode TUI, clicking such a link fails with:

```text
Only http and https links can be opened in the browser: docs/report.md
```

The TUI only opens `http:` and `https:` URLs. Relative paths, absolute paths, `~/` paths and `file://` URLs are all rejected. This plugin handles those links itself.

## Demo

<!-- TODO: add a short GIF or asciinema recording: click a link, file manager opens with the file selected -->

_Demo recording coming soon._

## Features

- **Click interception in the TUI.** A plain left-click on a local file link is handled by the plugin. Web links (`http:`, `https:`, `mailto:`) behave as before.
- **Three actions.** `reveal` shows the file selected in the system file manager (default). `open` opens it in the default application. `editor` opens it in your editor.
- **Line numbers.** `path:42`, `path:42:7` and `#L42` open your configured `editor` at that line. Without an `editor`, the plugin falls back to `action`.
- **Every common path form.** Relative (`docs/x.md`, `./x`, `../x`), absolute, `~/`, `file://` and percent-encoded names such as `Kredyty%20i%20koszt%20runner%C3%B3w.md`.
- **Project boundary.** Paths outside the project are refused unless you set `allowOutsideProject: true`.
- **`/links` command.** Lists the local file links from the current session, so you can reveal, open or edit any of them from a dialog. (`/open` is already a built-in opencode command.)
- **`open_file` agent tool.** The agent can show a file to you directly: `open_file({ path, line?, action? })`.
- **Localhost bridge.** A small HTTP endpoint on `127.0.0.1` with a random token, for clients where click interception is not possible. Optional `linkRewrite: "instruct"` asks the model to emit bridge URLs instead of plain paths.
- **Cross-platform.** Linux (DBus `FileManager1`, then `xdg-open`), WSL (`explorer.exe`), macOS (`open -R`) and Windows (`explorer /select`).

## Requirements

- **opencode 2.2.0 or later** (the 2.x plugin API). opencode 1.x is not supported.
- A desktop session on the machine where the TUI runs, for `reveal` and `open`. See [Supported systems](#supported-systems).

## Install

opencode installs plugins listed in its config automatically on startup. You do not need to run `npm install` yourself. Add the plugin to the `plugins` array of either config file:

- global: `~/.config/opencode/opencode.json`
- per project: `<project>/opencode.json`

### From npm

```json
{
  "plugins": ["@daropotter/opencode-filelink"]
}
```

### From GitHub

```json
{
  "plugins": ["github:daropotter/opencode-filelink"]
}
```

Append `#<branch-or-tag>` to pin a ref, for example `github:daropotter/opencode-filelink#v0.1.0`.

npm and GitHub specs are installed into `~/.cache/opencode/npm/`. Restart opencode to pick up a new version.

### From a local checkout (development)

```bash
git clone https://github.com/daropotter/opencode-filelink.git
cd opencode-filelink
bun install
bun run build
```

```json
{
  "plugins": ["/absolute/path/to/opencode-filelink"]
}
```

Local paths (`./x`, `../x`, absolute, `file://`) are resolved against the directory of the config file that lists them. opencode watches them and reloads the plugin when they change.

## Configuration

To pass options, use the object form of a `plugins` entry:

```json
{
  "plugins": [
    {
      "package": "@daropotter/opencode-filelink",
      "options": {
        "action": "reveal",
        "editor": "code -g {file}:{line}:{col}"
      }
    }
  ]
}
```

> [!IMPORTANT]
> Use the object form `{ "package": ..., "options": ... }`. The tuple form `["@daropotter/opencode-filelink", { ... }]` is not valid in opencode 2.x. opencode skips the entry with a `skipped malformed recognized value` diagnostic, and the plugin does not load at all.

> [!NOTE]
> In opencode 2.2.0 the TUI part of a plugin receives empty options. To work around this, the plugin also reads its own entry from the opencode config files directly: the global `~/.config/opencode/opencode.json(c)` and the project `opencode.json(c)`, with the project file taking precedence. You configure it once, in the usual place.

### Options

<!-- keep in sync with src/config.ts -->

| Option | Type | Default | Description |
|---|---|---|---|
| `action` | `"reveal"` \| `"open"` \| `"editor"` | `"reveal"` | What a click on a link without a line number does. `reveal` shows the file selected in the file manager. `open` opens it with the default application. `editor` opens it with the `editor` command. |
| `editor` | `string` | unset | Editor command template. Placeholders: `{file}`, `{line}`, `{col}`, `{dir}`. Used for links with a line number (`path:42`, `#L42`) and for `action: "editor"`. The template is split into arguments and run without a shell. When unset, links with a line number fall back to `action`. |
| `allowOutsideProject` | `boolean` | `false` | Allow links to files outside the project and session directories (absolute paths, `~/`, `file://`). |
| `bridge.enabled` | `boolean` | `true` | Start the localhost bridge (see [How it works](#how-it-works)). |
| `bridge.port` | `number` | `0` (random) | Port of the bridge on `127.0.0.1`. |
| `linkRewrite` | `"off"` \| `"instruct"` | `"off"` | `instruct` adds a system instruction asking the model to write local file links as bridge URLs. Read the [security note](#security) before enabling it. |

### Editor templates

| Editor | `editor` value |
|---|---|
| VS Code | `code -g {file}:{line}:{col}` |
| Cursor | `cursor -g {file}:{line}:{col}` |
| Zed | `zed {file}:{line}:{col}` |
| JetBrains IDEs | `idea --line {line} {file}` |
| Sublime Text | `subl {file}:{line}:{col}` |

Terminal editors such as `nvim +{line} {file}` would compete with the opencode TUI for the same terminal. Launch them in a new terminal window instead, for example `kitty -e nvim +{line} {file}`.

### Examples

Open files in the default application instead of revealing them:

```json
{
  "plugins": [
    { "package": "@daropotter/opencode-filelink", "options": { "action": "open" } }
  ]
}
```

Always open in VS Code, and allow links into your home directory:

```json
{
  "plugins": [
    {
      "package": "@daropotter/opencode-filelink",
      "options": {
        "action": "editor",
        "editor": "code -g {file}:{line}:{col}",
        "allowOutsideProject": true
      }
    }
  ]
}
```

Fixed bridge port with link rewriting, for a client that cannot intercept clicks:

```json
{
  "plugins": [
    {
      "package": "@daropotter/opencode-filelink",
      "options": {
        "bridge": { "enabled": true, "port": 47777 },
        "linkRewrite": "instruct"
      }
    }
  ]
}
```

## Expected behavior

Relative paths are resolved against the session directory. "Editor" means the `editor` command when it is set.

| Link in the message | `action: "reveal"` (default) | `action: "open"` | `action: "editor"` |
|---|---|---|---|
| `docs/report.md`, `./docs/report.md` | File manager opens with the file selected | Opens in the default app | Opens in the editor |
| `docs/` (a directory) | File manager shows the directory selected in its parent | Opens the directory in the file manager | Opens the directory in the editor |
| `src/file.go:42`, `src/file.go:42:7`, `src/file.go#L42` | Editor at line 42 (col 7); without `editor`: reveal | Editor at the line; without `editor`: open | Editor at the line |
| `img/my%20pic.png` | Decoded to `img/my pic.png`, then as above | as above | as above |
| `/abs/path`, `~/notes.md`, `file:///abs/path` inside the project | as for relative paths | as above | as above |
| `/abs/path`, `~/notes.md`, `file:///abs/path` outside the project | Refused with a toast, unless `allowOutsideProject: true` | same | same |
| `docs/missing.md` (parent exists) | Reveals the parent directory | Error toast: file not found | Error toast: file not found |
| `https://example.com`, `mailto:` | Unchanged: opened by opencode in the browser | same | same |
| `#section` (anchor only) | Unchanged | same | same |

<!-- verify the missing-file and directory rows against the implementation -->

## Supported systems

| System | `reveal` | `open` | Notes |
|---|---|---|---|
| **Linux** | DBus `org.freedesktop.FileManager1.ShowItems` (via `busctl`, `gdbus` or `dbus-send`), then `xdg-open` on the parent directory | `xdg-open` | Nautilus, Dolphin, Nemo, Caja and Thunar implement `FileManager1`. With a file manager that does not (for example PCManFM, or terminal file managers), the plugin falls back to opening the parent directory without selecting the file. |
| **WSL** | `explorer.exe /select,<path>`, with the path converted by `wslpath -w` | `wslview` (from wslu) if installed, else `explorer.exe` | Files on the Linux side open as `\\wsl.localhost\<distro>\...`. WSL is detected through `/proc/version` or `WSL_DISTRO_NAME`. |
| **macOS** | `open -R <path>` (Finder) | `open <path>` | |
| **Windows** | `explorer.exe /select,"<path>"` | `explorer.exe "<path>"` | `explorer.exe` returns a non-zero exit code even on success; the plugin ignores it. Commands never go through `cmd /c start`. |
| **Headless or remote server** | Not available | Not available | There is no display or session bus to show anything on. See [FAQ](#troubleshooting-and-faq). |

All commands are started directly with an argument list (`spawn` with `shell: false`). File names are never interpolated into a shell command line.

## How it works

The plugin has two parts, both loaded from the single `plugins` entry.

**TUI part (click interception).** When you left-click in the opencode TUI, the TUI asks the renderer which link is under the cursor (`renderer.getLinkAt`) and passes the result to its browser opener, which rejects anything that is not `http(s)`. The plugin wraps `getLinkAt`. If the link is a local file, the plugin handles it and returns nothing to the TUI, so the error never appears. Other links pass through unchanged. The wrapper is removed when the plugin unloads. The TUI part also provides the `/links` command and records every intercepted link for it.

Because the click is handled in the TUI process, the file is opened on the machine and in the desktop session where you are actually sitting.

**Server part (tool and bridge).** The server part registers the `open_file` agent tool and starts the localhost bridge: an HTTP server bound to `127.0.0.1` on a random port (or `bridge.port`). A request such as `http://127.0.0.1:<port>/o?p=docs%2Freport.md&t=<token>` reveals or opens the file. Since this is an ordinary `http` URL, any client that can open web links can use it. With `linkRewrite: "instruct"` the plugin asks the model to write local file links in that form. Bridge URLs are turned back into plain paths in the conversation history.

Both parts share the same link parser, path policy and per-OS launcher.

## Security

- **Project boundary.** Every target is resolved with `realpath` and must lie inside the project, worktree or session directory, so `../` and symlinks cannot escape. Set `allowOutsideProject: true` to lift this restriction.
- **No shell.** Commands are spawned with an argument list. File names and editor placeholders are substituted per argument and never parsed by a shell.
- **Bridge.** It listens only on `127.0.0.1`, never on `0.0.0.0`. It accepts only `GET` requests with a matching `Host` header (DNS rebinding protection), rejects foreign `Origin` headers, rate-limits requests and requires a random per-process token or signature. It applies the same path policy as clicks. The token is never written to logs.
- **`linkRewrite: "instruct"` sends the bridge token to your LLM provider**, because the model has to write it into the URLs. The token only allows revealing or opening files inside the allowed directories on your own machine through `127.0.0.1`. Still, it leaves your machine, and the model may echo it in places you do not expect. This is why the option is off by default.
- **The agent tool** can only reveal or open files under the same policy. It cannot run arbitrary commands.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Troubleshooting and FAQ

**Nothing happens when I click a link.**
- Make sure it is a plain left-click: no Ctrl, Alt or Shift, and no dragging. Modified clicks and drags are left to the TUI and your terminal.
- Make sure the plugin loaded. Check the opencode log for `opencode-filelink`. A plugin entry written in the tuple form is skipped silently; use the object form shown in [Configuration](#configuration).
- The file may be outside the project. Look for a toast, or set `allowOutsideProject: true`.
- On Linux, the server part and the TUI may run in an environment without `DISPLAY`, `WAYLAND_DISPLAY` or `DBUS_SESSION_BUS_ADDRESS` (for example over SSH). Try `xdg-open .` in the same shell to check.

**My terminal opens the link itself, or tries to open a relative path.**
Terminals with hyperlink support (OSC 8), such as kitty, WezTerm, iTerm2 or Windows Terminal, may handle Ctrl+click or Cmd+click on their own, with the raw relative path. The plugin cannot change what the terminal does. Use a plain click.

**I run opencode on a remote server.**
The file lives on the server, but the file manager would have to run on your laptop. `reveal` and `open` cannot bridge that gap. Use `/links` to see and copy the paths, set `action: "editor"` with an editor that works over SSH (for example VS Code Remote's `code` CLI inside its integrated terminal), or open the files in your remote-development tool. The localhost bridge is also bound to the server's `127.0.0.1`, so it is not reachable from your laptop unless you forward the port, and even then it opens files on the server.

**Windows: Explorer opens the wrong folder, or nothing happens.**
Explorer returns a non-zero exit code even on success, so the plugin cannot always tell success from failure. Check that the path does not contain characters Windows does not allow. For `editor`, use the real command name (`code`); the plugin handles `.cmd` shims. Windows support has had less testing than Linux and macOS, so bug reports are very welcome.

**WSL: the file opens in a Windows app instead of a Linux one.**
That is expected. Under WSL, `reveal` uses Windows Explorer and `open` uses `wslview`, which hands the file to Windows. Use `editor` with a Linux-side command if you prefer.

**Can I use `/open`?**
No, `/open` is a built-in opencode command (open session or project). The plugin uses `/links`.

## Limitations

- Click interception relies on how the opencode TUI looks up links internally (`renderer.getLinkAt`). It is verified on opencode 2.2.0 and may break in a later release. The plugin detects the method and shows a one-time notice if it is missing; the bridge and the `open_file` tool keep working. A link handler API for TUI plugins in opencode itself would remove this dependency.
- opencode 2.x has no hook to edit assistant text after it is generated, so plain paths in messages cannot be rewritten into bridge URLs. `linkRewrite: "instruct"` relies on the model following the instruction.
- The opencode desktop (GUI) app is not supported yet. It has its own link handler API, planned for a later release.
- Terminal editors cannot share the terminal with the TUI; launch them in a new terminal window.

## Development

Requires [Bun](https://bun.sh) 1.2 or later (opencode runs plugins on Bun).

```bash
bun install          # install dependencies
bun run typecheck    # type-check without emitting
bun test             # run the test suite
bun run build        # compile to dist/
```

To try your build in opencode, point a project's `opencode.json` at your checkout (see [From a local checkout](#from-a-local-checkout-development)). opencode reloads local plugins when files change.

Design notes and spike findings are in [docs/design.md](docs/design.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## License

[MIT](LICENSE) © 2026 Daro

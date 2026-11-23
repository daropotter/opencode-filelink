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

- **Click interception in the TUI.** A plain left-click on a local file link is handled by the plugin. Other links (`http:`, `https:`, `mailto:`, `#anchor`) are left to opencode.
- **Three actions.** `reveal` shows the file selected in the system file manager (default). `open` opens it in the default application. `editor` opens it in your editor.
- **Line numbers.** `path:42`, `path:42:7`, `#L42`, `#L42C7` and `#L42-L50` open your editor at that line when one is configured. Without an editor, the plugin falls back to `action`.
- **Every common path form.** Relative (`docs/x.md`, `./x`, `../x`), absolute, `~/`, `file://`, Windows drive and UNC paths, and percent-encoded names such as `Kredyty%20i%20koszt%20runner%C3%B3w.md`.
- **Project boundary.** Paths outside the project are refused unless you list them in `extraRoots` or set `allowOutsideProject: true`.
- **`/links` command** (alias `/files`, also in the command palette). Lists the local file links in the current session, so you can reveal, open or edit any of them from a dialog. (`/open` is already a built-in opencode command.)
- **Agent tools.** `open_file({ path, line?, action? })` and `reveal_file({ path })` let the agent show you a file directly.
- **Localhost bridge.** A small HTTP endpoint on `127.0.0.1` with a random token, for clients where click interception is not possible. Optional `linkRewrite: "instruct"` asks the model to write bridge URLs instead of plain paths.
- **Cross-platform.** Linux (DBus `FileManager1`, then `xdg-open`), WSL (`explorer.exe`, `wslview`), macOS (`open -R`) and Windows (`explorer /select`). See [Supported systems](#supported-systems) for what has been tested where.

## Requirements

- **opencode 2.2.0 or later** (the 2.x plugin API). opencode 1.x is not supported.
- A desktop session on the machine where opencode runs, for `reveal` and `open`. See [Supported systems](#supported-systems).

opencode runs plugins on its bundled Bun runtime, so you do not need to install Bun or Node to use the plugin. To build it from source you need Bun 1.2 or later (see [Development](#development)).

## Install

opencode installs plugins listed in its config automatically on startup. You do not need to run `npm install` yourself. Add the plugin to the `plugins` array of a config file:

- global: `~/.config/opencode/opencode.json`
- per project: `<project>/opencode.json`

### From npm

```json
{
  "plugins": ["@daropotter/opencode-filelink"]
}
```

The plain string form loads the plugin with default options. To pass options, use the object form shown in [Configuration](#configuration).

npm specs are installed into `~/.cache/opencode/npm/`. Restart opencode to pick up a new version.

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

The plugin loads from the built `dist/` folder, so run `bun run build` first. Local paths (`./x`, `../x`, `~/x`, absolute, `file://`) are resolved against the directory of the config file that lists them. opencode watches them and reloads the plugin when they change.

> [!NOTE]
> Installing straight from GitHub (`github:daropotter/opencode-filelink`) is not supported yet: the repository does not contain the built `dist/` folder. Use the npm package or a local checkout.

## Configuration

To pass options, use the object form of a `plugins` entry:

```json
{
  "plugins": [
    {
      "package": "@daropotter/opencode-filelink",
      "options": {
        "action": "reveal",
        "editor": "vscode"
      }
    }
  ]
}
```

> [!IMPORTANT]
> Use the object form `{ "package": ..., "options": ... }`. The tuple form `["@daropotter/opencode-filelink", { ... }]` is not valid in opencode 2.x. opencode skips the entry with a `skipped malformed recognized value` diagnostic, and the plugin does not load at all.

### Where options are read from

In opencode 2.2.0 the TUI part of a plugin receives empty options. So both parts of the plugin also read their own entry from the opencode config files directly. You configure it once, in the usual place. Sources, from lowest to highest precedence:

1. Defaults.
2. Global config: `opencode.json`, `opencode.jsonc`, `cli.json`, `cli.jsonc` in `$OPENCODE_CONFIG_DIR`, or else `$XDG_CONFIG_HOME/opencode`, or else `~/.config/opencode`.
3. The file named by `$OPENCODE_CONFIG`.
4. Project config: `opencode.json(c)` and `.opencode/opencode.json(c)` in every directory from the git root down to the project directory, inner directories winning. Without a git root, only the project directory itself is read.
5. Options that opencode passes to the plugin directly.

Later sources override earlier ones key by key (`bridge` is merged one level deep). The plugin recognizes its entry under `plugins` (or the legacy `plugin` key) when the spec is:

- the package name, optionally with `npm:` and/or `@<version>` (`npm:@daropotter/opencode-filelink@0.1.0`);
- a `github:` or git spec ending in `opencode-filelink` (with an optional `.git` or `#ref`);
- a local path whose `package.json` has the name `@daropotter/opencode-filelink`.

Invalid values and unknown keys are ignored with a warning in the [debug log](#troubleshooting-and-faq), and the default is used.

### Options

<!-- keep in sync with src/config.ts -->

| Option | Type | Default | Description |
|---|---|---|---|
| `action` | `"reveal"` \| `"open"` \| `"editor"` | `"reveal"` | What a click on a link without a line number does. `reveal` shows the file selected in the file manager. `open` opens it with the default application. `editor` opens it with `editor`. |
| `lineAction` | `"reveal"` \| `"open"` \| `"editor"` | unset | What a click on a link with a line number does. When unset: `"editor"` if an editor is configured, otherwise `action`. |
| `editor` | `string` \| `string[]` | unset | Editor command: a [preset name](#editor), a command template string, or an argument array. See [Editor](#editor). |
| `editorFromEnv` | `boolean` | `false` | When `editor` is unset, build the editor command from `$VISUAL` or `$EDITOR`. Terminal editors are skipped. |
| `allowOutsideProject` | `boolean` | `false` | Allow links to any existing file, including outside the project, session directory and `extraRoots`. |
| `extraRoots` | `string[]` | `[]` | Additional directories links may point into. Absolute, `~/`, or relative to the project directory. |
| `intercept` | `boolean` | `true` | Intercept clicks on local links in the TUI. With `false`, only `/links`, the tools and the bridge work. |
| `toast` | `boolean` | `true` | Show a toast after a successful action. Errors are always shown. |
| `keybind` | `string` \| `false` | `false` | Key binding for the `/links` command, for example `"<leader>o"`. |
| `bridge` | `{ enabled?: boolean, port?: number }` \| `boolean` | `{ "enabled": true, "port": 0 }` | The [localhost bridge](#how-it-works). `port: 0` picks a random free port. `true`/`false` is short for `{ "enabled": ... }`. |
| `linkRewrite` | `"off"` \| `"instruct"` | `"off"` | `instruct` adds a system instruction asking the model to write local file links as bridge URLs. It starts the bridge even when `bridge.enabled` is `false`. Read the [security notes](#security) first: the bridge token is sent to your LLM provider. |
| `tools` | `boolean` | `true` | Register the `open_file` and `reveal_file` agent tools. |

### Editor

`editor` accepts three forms:

- **A preset name:** `vscode` / `code`, `code-insiders`, `vscodium` / `codium`, `cursor`, `windsurf`, `zed`, `subl` / `sublime`, `idea`, `webstorm`, `pycharm`, `goland`.
- **A template string**, such as `"code -g {file}:{line}:{col}"`. It is split into arguments like a POSIX shell would (quotes and backslashes are honored), but nothing is expanded and no shell runs it.
- **An argument array**, such as `["code", "-g", "{file}:{line}:{col}"]`.

Placeholders are substituted per argument: `{file}` (absolute path), `{line}`, `{col}` and `{dir}` (the file's directory, or the directory itself for a directory link). If the template has neither `{file}` nor `{dir}`, `{file}` is appended. For a link without a line number, `:{line}` and `:{col}` suffixes are removed and a standalone `{line}` argument is dropped together with the flag before it (`--line {line}`).

| Preset | Command |
|---|---|
| `vscode`, `cursor`, `windsurf`, ... | `code -g {file}:{line}:{col}` (with the matching command name) |
| `zed`, `subl` | `zed {file}:{line}:{col}`, `subl {file}:{line}:{col}` |
| `idea`, `webstorm`, `pycharm`, `goland` | `idea --line {line} --column {col} {file}` (with the matching command name) |

Terminal editors (`vi`, `vim`, `nvim`, `nano`, `micro`, `hx`, `helix`, `kak`, `emacs -nw` and similar) are rejected, because they would compete with the opencode TUI for the same terminal. Launch them in a new terminal window instead, for example `"kitty -e nvim +{line} {file}"`.

With `editorFromEnv: true`, the first of `$VISUAL` and `$EDITOR` that is not a terminal editor is used. A known editor command gets its preset's line arguments; any other command gets the file appended (and `--wait` / `-w` removed).

### Examples

Open files in the default application instead of revealing them:

```json
{
  "plugins": [
    { "package": "@daropotter/opencode-filelink", "options": { "action": "open" } }
  ]
}
```

Always open in VS Code, and allow links into a notes folder in your home directory:

```json
{
  "plugins": [
    {
      "package": "@daropotter/opencode-filelink",
      "options": {
        "action": "editor",
        "editor": "vscode",
        "extraRoots": ["~/notes"]
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
        "bridge": { "port": 47777 },
        "linkRewrite": "instruct"
      }
    }
  ]
}
```

## Expected behavior

In the TUI, relative paths are resolved against the current session's directory (or the project directory). "Editor" means the configured `editor`.

| Link in the message | `action: "reveal"` (default) | `action: "open"` | `action: "editor"` |
|---|---|---|---|
| `docs/report.md`, `./docs/report.md` | File manager opens with the file selected | Opens in the default app | Opens in the editor |
| `docs/` (a directory) | File manager shows the directory selected in its parent | Opens the directory in the file manager | Opens the directory in the editor |
| `src/file.go:42`, `src/file.go:42:7`, `src/file.go#L42` | Editor at line 42 (col 7); without an editor: reveal | Editor at the line; without an editor: open | Editor at the line |
| `img/my%20pic.png` | Decoded to `img/my pic.png`, then as above | as above | as above |
| `/abs/path`, `~/notes.md`, `file:///abs/path` inside the allowed roots | as for relative paths | as above | as above |
| `/abs/path`, `~/notes.md`, `file:///abs/path` outside the allowed roots | Error toast: refused, unless `allowOutsideProject: true` | same | same |
| `docs/missing.md` | Error toast: `File not found` | same | same |
| `https://example.com`, `mailto:`, `#section` | Not intercepted: opencode handles it as before | same | same |

`lineAction` overrides the line-number row. With `action: "editor"` and no editor configured, the plugin opens the file in the default app instead. For `path:42`, a file literally named `path:42` is tried first.

## Supported systems

| System | `reveal` | `open` | Status |
|---|---|---|---|
| **Linux** | DBus `org.freedesktop.FileManager1.ShowItems` via `busctl`, then `gdbus`, then `dbus-send`; if none succeeds, `xdg-open` (then `gio open`) on the parent directory | `xdg-open`, then `gio open` | Developed and smoke-tested on opencode 2.2.0 |
| **WSL** | `explorer.exe /select,<path>`, with the path converted by `wslpath -w` | `wslview` (from wslu), then `explorer.exe` | Implemented; needs community verification |
| **macOS** | `open -R <path>` (Finder) | `open <path>` | Implemented; needs community verification |
| **Windows** | `explorer.exe /select,"<path>"` | `explorer.exe "<path>"` | Implemented; needs community verification |
| **Headless or remote server** | Not available | Not available | There is no display or session bus. See [FAQ](#troubleshooting-and-faq). |

Notes:

- **Linux:** Nautilus, Dolphin, Nemo, Caja and Thunar implement `FileManager1`. With a file manager that does not (for example PCManFM, or terminal file managers), the plugin opens the parent directory without selecting the file. The DBus calls must exit successfully to count; the other commands count as successful once started. Other Unix systems (BSDs) use the Linux commands.
- **WSL:** detected through `WSL_DISTRO_NAME`, `WSL_INTEROP` or `/proc/version`. Without `wslpath`, `/mnt/c/...` becomes `C:\...` and other paths become `\\wsl.localhost\<distro>\...`. The `editor` command runs on the Linux side with the Linux path.
- **Windows:** `explorer.exe` is never waited for, because it returns a non-zero exit code even on success. The plugin therefore cannot detect when Explorer fails. Paths containing `"`, `<`, `>`, `|`, `*`, `?` or control characters are refused. Commands never go through `cmd /c start`.

On all systems, commands are started directly with an argument list (`spawn` with `shell: false`). File names are never interpolated into a shell command line. The CI runs the unit tests (including command construction for every platform) on Linux, macOS and Windows; reports from real macOS, Windows and WSL setups are very welcome.

## How it works

The plugin has two parts, both loaded from the single `plugins` entry.

**TUI part (click interception and `/links`).** When you left-click in the opencode TUI, the TUI asks the renderer which link is under the cursor (`renderer.getLinkAt`) and passes the result to its browser opener, which rejects anything that is not `http(s)`. The plugin wraps `getLinkAt`. If the link is a local file, the plugin handles it and returns nothing to the TUI, so the error never appears. Other links pass through unchanged. The wrapper is removed when the plugin unloads. Because the click is handled in the TUI process, the file is opened on the machine and in the desktop session where the TUI runs.

The `/links` command (alias `/files`, palette entry "File links in this session") lists the local links in the current session's messages (links inside code blocks are ignored), followed by links you clicked recently. Entries are marked `directory`, `missing` or `outside project`. In the dialog:

| Key | Action |
|---|---|
| Enter | The configured action (same as a click) |
| `ctrl+r` | reveal |
| `ctrl+o` | open |
| `ctrl+e` | editor (only shown when an editor is configured) |

**Server part (tools and bridge).** The server part registers the `open_file` and `reveal_file` agent tools and starts the localhost bridge: an HTTP server bound to `127.0.0.1` on a random port (or `bridge.port`). Relative paths are resolved against the project directory. The bridge accepts:

```text
http://127.0.0.1:<port>/open?path=<path>&line=<n>&action=<reveal|open|editor>&t=<token>
http://127.0.0.1:<port>/o?p=<path>&l=<n>&a=<action>&t=<token>
```

`line` and `action` are optional. Since these are ordinary `http` URLs, any client that can open web links can use them. When the bridge is running, the tools' output includes such a URL for the user. With `linkRewrite: "instruct"` the plugin adds a system instruction asking the model to write local file links in this form, and turns bridge URLs in earlier messages back into plain paths before they are sent to the model.

Both parts share the same link parser, path policy and per-OS launcher.

## Security

- **Project boundary.** Every target is resolved with `realpath` and must lie inside the session directory, the project directory or one of `extraRoots`, so `../` and symlinks cannot escape. `allowOutsideProject: true` lifts this restriction.
- **No shell.** Commands are spawned with an argument list. File names and editor placeholders are substituted per argument and never parsed by a shell.
- **Bridge.** It listens only on `127.0.0.1`. It accepts only `GET` and `HEAD`, requires a `Host` header of `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding protection), rejects foreign `Origin` headers, and allows at most 10 requests per second. Every request needs a random token (32 bytes, generated on each start) that is compared in constant time; there is no per-link signature. Responses are small HTML pages with a nonce-based Content Security Policy, `X-Frame-Options: DENY` and `Cache-Control: no-store`. The bridge applies the same path policy as clicks, and the token is not written to the plugin's log.
- **The bridge token can reach your LLM provider.** With `linkRewrite: "instruct"` it is part of the system instruction, because the model has to write it into URLs. Also, while the bridge is running, the output of `open_file` and `reveal_file` contains a bridge URL with the token, and tool output is part of the conversation sent to the provider. The token only allows revealing or opening files inside the allowed directories on your own machine through `127.0.0.1`, and it changes every time opencode starts. If you do not want it to leave your machine, set `bridge: false` (and keep `linkRewrite: "off"`), or `tools: false`.
- **The agent tools** can only reveal or open files under the same policy. They cannot run arbitrary commands.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Troubleshooting and FAQ

**How do I see what the plugin is doing?**
The plugin never writes to stdout or stderr, because that would corrupt the TUI. Set `OPENCODE_FILELINK_LOG` to a file path to log both parts (config warnings, intercepted clicks, commands that failed):

```bash
OPENCODE_FILELINK_LOG=/tmp/filelink.log opencode
```

Add `OPENCODE_FILELINK_DRY_RUN=1` to log the commands the plugin would run instead of running them.

**Nothing happens when I click a link.**
- Make sure it is a plain left-click: no Ctrl, Alt or Shift, and no dragging. Modified clicks and drags are left to the TUI and your terminal.
- Make sure the plugin loaded: `/links` should exist. A plugin entry written in the tuple form is skipped; use the object form shown in [Configuration](#configuration).
- If click interception is not available in your opencode version, the plugin shows a warning toast at startup. Use `/links` instead.
- The file may be missing or outside the project. Look for an error toast, or check the debug log.
- On Linux, opencode may run in an environment without `DISPLAY`, `WAYLAND_DISPLAY` or `DBUS_SESSION_BUS_ADDRESS` (for example over SSH). Try `xdg-open .` in the same shell to check.

**My terminal opens the link itself, or tries to open a relative path.**
Terminals with hyperlink support (OSC 8), such as kitty, WezTerm, iTerm2 or Windows Terminal, may handle Ctrl+click or Cmd+click on their own, with the raw relative path. The plugin cannot change what the terminal does. Use a plain click.

**I run opencode on a remote server.**
The file lives on the server, but the file manager would have to run on your laptop. `reveal` and `open` cannot bridge that gap. Use `/links` to see the paths, set `action: "editor"` with an editor that works over SSH (for example VS Code Remote's `code` CLI inside its integrated terminal), or open the files in your remote-development tool. The localhost bridge is also bound to the server's `127.0.0.1`, so it is not reachable from your laptop unless you forward the port, and even then it opens files on the server.

**Windows: Explorer opens the wrong folder, or nothing happens.**
Explorer returns a non-zero exit code even on success, so the plugin cannot tell success from failure. Check that the path does not contain characters Windows does not allow. Windows support has had less testing than Linux, so bug reports are very welcome.

**WSL: the file opens in a Windows app instead of a Linux one.**
That is expected. Under WSL, `reveal` uses Windows Explorer and `open` uses `wslview`, which hands the file to Windows. Use `editor` with a Linux-side command if you prefer.

**Can I use `/open`?**
No, `/open` is a built-in opencode command (open session or project). The plugin uses `/links` and `/files`.

## Limitations

- Click interception relies on how the opencode TUI looks up links internally (`renderer.getLinkAt`). It is verified on opencode 2.2.0 and may break in a later release. If the method is missing, the plugin shows a warning toast; `/links`, the tools and the bridge keep working. A link handler API for TUI plugins in opencode itself would remove this dependency.
- opencode 2.x has no hook to edit assistant text after it is generated, so plain paths in messages cannot be rewritten into bridge URLs. `linkRewrite: "instruct"` relies on the model following the instruction.
- On Windows, editors installed as `.cmd` shims (such as `code`) are retried as `code.cmd` when `code` cannot be started. Whether this works depends on the runtime's rules for launching `.cmd` files without a shell and has not been verified on real Windows; if it fails, set `editor` to the full path of the editor's `.exe`.
- Recently clicked links in `/links` are kept in memory only and are lost when opencode restarts.
- The opencode desktop (GUI) app is not supported yet. It has its own link handler API, planned for a later release.
- Terminal editors cannot share the terminal with the TUI; launch them in a new terminal window.

## Development

Requires [Bun](https://bun.sh) 1.2 or later (`mise.toml` pins the version used for development).

```bash
bun install          # install dependencies
bun run typecheck    # type-check without emitting
bun run lint         # Biome checks
bun test             # run the test suite
bun run build        # compile to dist/
```

To try your build in opencode, point a project's `opencode.json` at your checkout (see [From a local checkout](#from-a-local-checkout-development)). `OPENCODE_FILELINK_LOG` and `OPENCODE_FILELINK_DRY_RUN=1` help when testing by hand.

Design notes and spike findings are in [docs/design.md](docs/design.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## License

[MIT](LICENSE) © 2026 Daro

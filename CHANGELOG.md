# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- TUI click interception for local file links (relative, `./`, `../`, absolute, `~/`, `file://`, Windows drive and UNC paths, percent-encoded), replacing the "Only http and https links can be opened in the browser" error. Scheme-less web addresses (`www.example.com`, `127.0.0.1:8080`) and links with control characters are not intercepted. Can be turned off with `intercept: false`.
- Actions `reveal` (default), `open` and `editor`, selected with `action`; `lineAction` for links with a line number.
- Line and column support for `path:42`, `path:42:7`, `#L42`, `#L42C7` and `#L42-L50`.
- `editor` option: preset names, a template string or an argument array, with `{file}`, `{line}`, `{col}` and `{dir}` placeholders, run without a shell. Terminal editors are rejected. `editorFromEnv` uses `$VISUAL` / `$EDITOR`.
- Project boundary policy with `extraRoots` and the `allowOutsideProject` opt-in, enforced before any file system access. Windows network and device paths are only allowed inside `extraRoots`. Missing files produce a "File not found" error toast.
- `open` reveals executable-like files (scripts, installers, shortcuts, app bundles) instead of running them, with a warning.
- `/links` TUI command (alias `/files`, palette entry, optional `keybind`) listing local file links in the current session, with reveal / open / editor dialog actions.
- `open_file` and `reveal_file` agent tools (`tools` option).
- Localhost bridge on `127.0.0.1` with a random per-process token, Host, Origin and fetch-metadata checks, side-effect-free `HEAD`, and rate limiting (`bridge` option). Opt-in `linkRewrite: "instruct"`; only in that mode do bridge URLs (and the token) appear in the system prompt and tool output.
- Platform support: Linux (DBus `FileManager1`, `xdg-open`, `gio`, with a hint when no graphical session is available), WSL (`explorer.exe`), macOS (`open -R`), Windows (`%SystemRoot%\explorer.exe /select`; editors resolved to an absolute `.exe`, batch files never run, VS Code-family `.cmd` shims mapped to the real executable).
- Reading plugin options from the global, `$OPENCODE_CONFIG` and project opencode config files, because opencode 2.2.0 passes empty options to the TUI part.
- `OPENCODE_FILELINK_LOG` debug log and `OPENCODE_FILELINK_DRY_RUN` mode.
- Installation from GitHub: a `prepare` script builds `dist/`.

[0.1.0]: https://github.com/daropotter/opencode-filelink/releases/tag/v0.1.0

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- TUI click interception for local file links (relative, `./`, `../`, absolute, `~/`, `file://`, percent-encoded), replacing the "Only http and https links can be opened in the browser" error.
- Actions `reveal` (default), `open` and `editor`, selected with the `action` option.
- Line and column support for `path:42`, `path:42:7` and `#L42`, opened with the `editor` command template.
- Project boundary policy with `allowOutsideProject` opt-in.
- `/links` TUI command listing local file links in the current session.
- `open_file` agent tool.
- Localhost bridge on `127.0.0.1` with a random token, and opt-in `linkRewrite: "instruct"`.
- Platform support: Linux (DBus `FileManager1`, `xdg-open`), WSL (`explorer.exe`), macOS (`open -R`), Windows (`explorer /select`).
- Reading plugin options from opencode config files in the TUI, where opencode 2.2.0 passes empty options.

[0.1.0]: https://github.com/daropotter/opencode-filelink/releases/tag/v0.1.0

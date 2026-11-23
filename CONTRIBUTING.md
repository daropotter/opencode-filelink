# Contributing

Thanks for your interest in improving opencode-filelink. Bug reports, platform test results and pull requests are all welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

Use the [issue forms](https://github.com/daropotter/opencode-filelink/issues/new/choose). For bugs, include the plugin version, opencode version (`opencode --version`), operating system, terminal, your plugin configuration and the exact link text that misbehaves.

Reports from Windows, WSL, macOS and less common Linux file managers are especially useful, because those paths are harder to test automatically.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

You need [Bun](https://bun.sh) 1.2 or later (`mise.toml` pins the version used for development) and opencode 2.2.0 or later.

```bash
git clone https://github.com/daropotter/opencode-filelink.git
cd opencode-filelink
bun install
bun run typecheck
bun run lint
bun test
bun run build
```

To try your changes in opencode, add your checkout to a test project's `opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-filelink"]
}
```

opencode loads the plugin from `dist/`, watches local plugins and reloads them on change. Rebuild with `bun run build` after editing `src/`.

For manual testing, `OPENCODE_FILELINK_LOG=<file>` writes a debug log of both plugin parts, and `OPENCODE_FILELINK_DRY_RUN=1` logs the commands the plugin would run instead of running them. The plugin never writes to stdout or stderr, because that would corrupt the TUI.

Design notes and the findings behind the current approach are in [docs/design.md](docs/design.md).

## Guidelines

- **Keep the core pure.** Link parsing, path policy and command building are plain functions that take the platform and a spawner as inputs. Add table tests for new cases, per OS where relevant.
- **Never use a shell.** Launch processes with `spawn(cmd, args, { shell: false })`. Do not build command strings.
- **No runtime dependencies.** Use `node:` built-ins only. Do not import `@opencode/plugin`; the host API types the plugin needs are declared in `src/types.ts`, and every host API is feature-detected.
- **Never throw from `setup`.** A failing server part disables the whole plugin in opencode 2.2.0, TUI part included. Log and degrade instead.
- **Keep the docs in sync.** If you add or change an option, update `src/config.ts`, the options table in `README.md` and `CHANGELOG.md` together.
- Follow the formatting in `.editorconfig` and run `bun run lint` (Biome).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with tests.
3. Run `bun run typecheck`, `bun run lint`, `bun test` and `bun run build` locally.
4. Add an entry under the upcoming version in `CHANGELOG.md`.
5. Open a pull request and fill in the template. CI runs the type check, tests and build on Linux, macOS and Windows.

Keep pull requests focused on one change. For larger changes, open an issue first to agree on the approach.

## Releasing (maintainers)

1. Update `version` in `package.json` and move the changelog entries under a dated `## [x.y.z] - YYYY-MM-DD` heading.
2. Commit, then tag: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The release workflow checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance and creates a GitHub release from the changelog section.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

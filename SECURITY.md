# Security Policy

## Supported versions

Only the latest released version of `@daropotter/opencode-filelink` receives security fixes.

| Version | Supported |
|---|---|
| latest 0.x | Yes |
| older | No |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/daropotter/opencode-filelink/security/advisories/new)).

Please include:

- the plugin version, opencode version and operating system;
- the configuration you used (redact anything private);
- steps to reproduce, and what an attacker could achieve.

You can expect an acknowledgement within 7 days. Once a fix is ready, it is released and the advisory is published, crediting you unless you prefer otherwise.

## Scope

Areas of particular interest:

- **Path policy:** opening or revealing files outside the allowed roots without `allowOutsideProject`, for example through `..`, symlinks, percent-encoding, `file://` or Windows drive and UNC paths.
- **Command execution:** any way for a link, file name, tool argument or editor placeholder to execute commands or inject arguments beyond the intended launcher.
- **Localhost bridge:** access from other origins or hosts, DNS rebinding, token bypass, or the bridge listening on anything other than `127.0.0.1`.

Known and documented behavior, not a vulnerability: the bridge token is sent to the configured LLM provider with `linkRewrite: "instruct"` (in the system instruction), and while the bridge is running it is also included in the output of the `open_file` and `reveal_file` tools. The token is per process and only allows revealing or opening files inside the allowed roots through `127.0.0.1`. See the README's Security section.

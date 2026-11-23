import { readFileSync } from "node:fs"

export type Platform = "linux" | "wsl" | "darwin" | "win32"

export interface DetectInput {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (path: string) => string
}

/**
 * Detect the platform family that decides which commands are used.
 * WSL is Linux with `WSL_DISTRO_NAME`/`WSL_INTEROP` set or "microsoft" in /proc/version.
 */
export function detectPlatform(input: DetectInput = {}): Platform {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "win32"
  if (platform === "linux") {
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl"
    try {
      const read = input.readFile ?? ((p: string) => readFileSync(p, "utf8"))
      if (/microsoft|wsl/i.test(read("/proc/version"))) return "wsl"
    } catch {
      // not available: plain Linux
    }
    return "linux"
  }
  // BSDs and others behave like desktop Linux (xdg-open, DBus).
  return "linux"
}

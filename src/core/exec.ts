import { execFile, type SpawnOptions, spawn } from "node:child_process"
import type { Command } from "./commands.js"
import { isBatchFile } from "./winexe.js"

/** The part of a ChildProcess the executor uses. */
export interface ChildLike {
  on(event: "spawn", cb: () => void): unknown
  on(event: "error", cb: (err: Error) => void): unknown
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown
  unref?(): void
}

export type Spawner = (cmd: string, args: readonly string[], options: SpawnOptions) => ChildLike

export interface Attempt {
  readonly cmd: string
  readonly args: readonly string[]
  readonly error?: string
}

export type ExecResult =
  | { readonly ok: true; readonly command: Command; readonly attempts: readonly Attempt[] }
  | { readonly ok: false; readonly message: string; readonly attempts: readonly Attempt[] }

export interface ExecOptions {
  readonly spawner?: Spawner
  /** How long to wait for a `wait: true` command before assuming it worked. */
  readonly waitTimeoutMs?: number
  /** How long to wait for a 'spawn'/'error' event before assuming the process started. */
  readonly spawnTimeoutMs?: number
  /**
   * Refuse to spawn `.cmd`/`.bat` files (they always run through cmd.exe,
   * which would interpret metacharacters in arguments). Default: on Windows.
   */
  readonly refuseBatchFiles?: boolean
}

export const defaultSpawner: Spawner = (cmd, args, options) => spawn(cmd, [...args], options)

function describeError(err: unknown, cmd: string): string {
  const e = err as NodeJS.ErrnoException | undefined
  if (e?.code === "ENOENT") return `${cmd}: command not found`
  if (e?.code === "EACCES") return `${cmd}: permission denied`
  return `${cmd}: ${e?.message ?? String(err)}`
}

function runOne(command: Command, opts: ExecOptions): Promise<string | undefined> {
  const spawner = opts.spawner ?? defaultSpawner
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (error: string | undefined) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(error)
    }
    if ((opts.refuseBatchFiles ?? process.platform === "win32") && isBatchFile(command.cmd)) {
      done(`${command.cmd}: refusing to run a batch file (it would be interpreted by cmd.exe)`)
      return
    }
    let child: ChildLike
    try {
      child = spawner(command.cmd, command.args, {
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        ...(command.verbatim ? { windowsVerbatimArguments: true } : {}),
        ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
      })
    } catch (err) {
      done(describeError(err, command.cmd))
      return
    }
    child.on("error", (err) => done(describeError(err, command.cmd)))
    if (command.wait) {
      child.on("exit", (code, signal) =>
        done(code === 0 ? undefined : `${command.cmd}: exited with ${code === null ? `signal ${signal}` : `code ${code}`}`),
      )
      timer = setTimeout(() => done(undefined), opts.waitTimeoutMs ?? 4000)
    } else {
      child.on("spawn", () => done(undefined))
      timer = setTimeout(() => done(undefined), opts.spawnTimeoutMs ?? 1500)
    }
    try {
      child.unref?.()
    } catch {
      // ignore
    }
  })
}

/** Try each command in order; the first that starts (or exits 0 when `wait`) wins. */
export async function runCommands(commands: readonly Command[], opts: ExecOptions = {}): Promise<ExecResult> {
  const attempts: Attempt[] = []
  for (const command of commands) {
    const error = await runOne(command, opts)
    attempts.push(error ? { cmd: command.cmd, args: command.args, error } : { cmd: command.cmd, args: command.args })
    if (!error) return { ok: true, command, attempts }
  }
  const message =
    commands.length === 0
      ? "No command available for this action on this platform"
      : `Could not launch any of: ${attempts.map((a) => a.error ?? a.cmd).join("; ")}`
  return { ok: false, message, attempts }
}

/** `wslpath -w <path>` → Windows path, or undefined when wslpath is unavailable. */
export function wslpath(posixPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("wslpath", ["-w", posixPath], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        const out = String(stdout ?? "").trim()
        resolve(err || !out ? undefined : out)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * A spawner that never starts anything; it records the commands and reports
 * success. Enabled with `OPENCODE_FILELINK_DRY_RUN=1` (used by smoke tests).
 */
export function createRecordingSpawner(record: (cmd: string, args: readonly string[]) => void): Spawner {
  return (cmd, args) => {
    record(cmd, args)
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    const child: ChildLike = {
      on(event: string, cb: (...a: never[]) => void) {
        const list = listeners[event] ?? []
        list.push(cb as (...a: unknown[]) => void)
        listeners[event] = list
        return child
      },
      unref() {},
    }
    queueMicrotask(() => {
      for (const cb of listeners.spawn ?? []) cb()
      for (const cb of listeners.exit ?? []) cb(0, null)
    })
    return child
  }
}

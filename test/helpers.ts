import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ChildLike, Spawner } from "../src/core/exec.js"

export type FakeBehaviour = "spawn" | "enoent" | "eacces" | "throw" | "silent" | { exit: number }

export interface SpawnCall {
  cmd: string
  args: readonly string[]
  options: Record<string, unknown>
}

/** A spawner that never starts processes. `behave` decides what each command does. */
export function fakeSpawner(behave: (cmd: string, args: readonly string[]) => FakeBehaviour = () => "spawn") {
  const calls: SpawnCall[] = []
  const spawner: Spawner = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], options: options as Record<string, unknown> })
    const b = behave(cmd, args)
    if (b === "throw") throw Object.assign(new Error(`spawn ${cmd} EINVAL`), { code: "EINVAL" })
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    const child: ChildLike & { unrefCalled: boolean } = {
      unrefCalled: false,
      on(event: string, cb: (...a: never[]) => void) {
        const list = listeners[event] ?? []
        list.push(cb as (...a: unknown[]) => void)
        listeners[event] = list
        return child
      },
      unref() {
        child.unrefCalled = true
      },
    }
    const emit = (event: string, ...a: unknown[]) => {
      for (const cb of listeners[event] ?? []) cb(...a)
    }
    setTimeout(() => {
      if (b === "enoent") emit("error", Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" }))
      else if (b === "eacces") emit("error", Object.assign(new Error(`spawn ${cmd} EACCES`), { code: "EACCES" }))
      else if (b === "spawn") {
        emit("spawn")
        emit("exit", 0, null)
      } else if (typeof b === "object") {
        emit("spawn")
        emit("exit", b.exit, null)
      }
      // "silent": never emits anything
    }, 0)
    return child
  }
  return { spawner, calls }
}

/** Temporary project tree. Paths are realpath'd (macOS /var → /private/var). */
export function tempTree(files: Record<string, string | null>): { root: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "filelink-test-")))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    if (content === null) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

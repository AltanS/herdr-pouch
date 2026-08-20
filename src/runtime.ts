/**
 * The handful of things Bun and Node spell differently.
 *
 * Pouch runs on either: Bun if the host has it, otherwise Node ≥ 22, which
 * executes TypeScript directly (bare `node file.ts` from 23.6, and behind
 * `--experimental-strip-types` before that — `scripts/run.sh` passes the flag
 * when it is needed). Keeping the divergence in one file is what makes that
 * cheap; nothing else in `src/` may reach for a runtime-specific global.
 */

import { spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const sleep = (ms: number): Promise<void> => delay(ms);

/**
 * Blocks the thread. Used only by the store's lock retry, which must not yield
 * — an async pause there would let a second mutation interleave inside the
 * critical section it is waiting to enter.
 */
export function sleepSync(ms: number): void {
  // Atomics.wait needs a SharedArrayBuffer-backed Int32Array and refuses to run
  // on the main thread in some hosts; the spin is the fallback of last resort.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command to completion, capturing its output. */
export function run(cmd: string[], args: string[], env?: Record<string, string>): Promise<RunResult> {
  const [bin, ...rest] = [...cmd, ...args];
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(bin!, rest, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/**
 * `run` that reports a missing binary instead of rejecting.
 *
 * A spawn ENOENT arrives as an error EVENT, not an exit code, so `run` rejects
 * — which aborts a caller mid-report with a stack trace. Callers that spawn
 * something the operator may plausibly not have (`git`, or `herdr` from a
 * non-interactive ssh shell whose PATH never sourced a profile) want the shell's
 * own "not found" code instead.
 */
export async function runSafe(cmd: string[], args: string[], env?: Record<string, string>): Promise<RunResult> {
  try {
    return await run(cmd, args, env);
  } catch (err) {
    return { stdout: "", stderr: (err as Error).message, code: 127 };
  }
}

/** Runs a command attached to this terminal — for handing control to $EDITOR. */
export function runInteractive(cmd: string[]): Promise<number> {
  const [bin, ...rest] = cmd;
  const stdio: StdioOptions = ["inherit", "inherit", "inherit"];
  return new Promise((resolve) => {
    const proc = nodeSpawn(bin!, rest, { stdio });
    proc.on("error", () => resolve(1));
    proc.on("close", (code) => resolve(code ?? 0));
  });
}

/** Reads all of stdin. Returns "" when stdin is a terminal. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

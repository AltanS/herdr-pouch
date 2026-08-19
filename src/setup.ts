/**
 * One-shot onboarding: link the plugin, install the CLI, add the keybindings.
 *
 * Everything here is idempotent and reports what it actually changed. A linked
 * plugin shows nothing on screen until a pouch holds a message, so an operator
 * who has to hand-edit config.toml afterwards cannot tell "installed" from
 * "broken" — this is the surface that answers that.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { BIN } from "./config.ts";
import { run } from "./runtime.ts";

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
export const PLUGIN_ID = "herdr.pouch";

/**
 * Defaults that are free in Herdr's own key list. A plugin bind SHADOWS a
 * built-in, so never add a chord here without checking Herdr's defaults again.
 * Insert-and-submit ships unbound: every remaining free chord was taken.
 */
export const KEYBINDS = [
  { key: "prefix+shift+o", action: "open", description: "Pouch: open" },
  { key: "prefix+shift+i", action: "insert-top", description: "Pouch: insert top" },
  { key: "prefix+shift+a", action: "compose", description: "Pouch: stash a message" },
];

const BEGIN = `# --- ${PLUGIN_ID} keybindings (added by \`${BIN} setup\`) ---`;
const END = `# --- end ${PLUGIN_ID} keybindings ---`;

/** Herdr's own config file — the same path resolution config.ts uses. */
export function configTomlPath(): string {
  if (process.env.HERDR_CONFIG_PATH) return process.env.HERDR_CONFIG_PATH;
  const home = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");
  return join(home, "config.toml");
}

/** The plugin's own directory — Herdr injects it, the CLI derives it. */
export function pluginRoot(): string {
  return process.env.HERDR_PLUGIN_ROOT || join(dirname(new URL(import.meta.url).pathname), "..");
}

function bindToml(bind: (typeof KEYBINDS)[number]): string {
  return [
    "[[keys.command]]",
    `key = "${bind.key}"`,
    'type = "shell"',
    `command = "herdr plugin action invoke ${bind.action} --plugin ${PLUGIN_ID}"`,
    `description = "${bind.description}"`,
  ].join("\n");
}

export function keysBlock(binds: typeof KEYBINDS): string {
  return [BEGIN, ...binds.map(bindToml), END].join("\n\n") + "\n";
}

export interface Step {
  ok: boolean;
  what: string;
  detail: string;
}

/** `herdr plugin list` prints text, not JSON — so match on the id. */
async function isLinked(): Promise<boolean> {
  const { stdout, code } = await run([HERDR_BIN], ["plugin", "list"]);
  return code === 0 && stdout.includes(PLUGIN_ID);
}

async function linkPlugin(root: string): Promise<Step> {
  if (await isLinked()) return { ok: true, what: "plugin", detail: `already linked (${PLUGIN_ID})` };
  const { stderr, code } = await run([HERDR_BIN], ["plugin", "link", root]);
  if (code !== 0) return { ok: false, what: "plugin", detail: `\`herdr plugin link ${root}\` failed: ${stderr.trim()}` };
  return { ok: true, what: "plugin", detail: `linked ${root}` };
}

export function installCli(root: string): Step {
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, BIN);
  const source = join(root, "bin", BIN);
  try {
    mkdirSync(binDir, { recursive: true });
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(source, link);
  } catch (err) {
    return { ok: false, what: "cli", detail: `could not link ${link}: ${(err as Error).message}` };
  }
  const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
  return {
    ok: true,
    what: "cli",
    detail: onPath ? `${link}` : `${link} — add ${binDir} to your PATH to use it`,
  };
}

/** A key already spoken for anywhere in the config, ours or the operator's. */
function boundKeys(toml: string): Set<string> {
  const keys = new Set<string>();
  for (const match of toml.matchAll(/^\s*key\s*=\s*"([^"]+)"/gm)) keys.add(match[1]!.toLowerCase());
  return keys;
}

/**
 * Writes the keybindings into Herdr's config.toml.
 *
 * The candidate is validated by pointing `herdr config check` at a COPY through
 * HERDR_CONFIG_PATH: a config that fails to parse costs the operator every
 * binding they have, so the real file is only touched once Herdr has accepted
 * the result. The previous file is kept alongside as `.pouch-backup`.
 */
export async function installKeys(): Promise<Step> {
  const path = configTomlPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const taken = boundKeys(existing);

  const pending = KEYBINDS.filter((b) => !existing.includes(`invoke ${b.action} --plugin ${PLUGIN_ID}`));
  const clashing = pending.filter((b) => taken.has(b.key));
  const toAdd = pending.filter((b) => !taken.has(b.key));

  // A clash is the operator's own binding winning, not a failure: say which
  // action stayed unbound and leave their config alone.
  if (!toAdd.length) {
    const detail = clashing.length
      ? `already present — ${clashing
          .map((b) => `${b.key} is yours, so \`${b.action}\` stays unbound`)
          .join("; ")}`
      : "already present";
    return { ok: true, what: "keys", detail };
  }

  // Drop any earlier managed block so re-running never stacks duplicates.
  const stripped = existing.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, "g"), "");
  const candidate = `${stripped.trimEnd()}\n\n${keysBlock(toAdd)}`;

  mkdirSync(dirname(path), { recursive: true });
  const probe = join(dirname(path), ".pouch-config-check.toml");
  writeFileSync(probe, candidate);
  const check = await run([HERDR_BIN], ["config", "check"], { HERDR_CONFIG_PATH: probe });
  rmSync(probe, { force: true });
  if (check.code !== 0) {
    return {
      ok: false,
      what: "keys",
      detail: `Herdr rejected the keybindings, so ${path} was left alone: ${(check.stderr || check.stdout).trim()}`,
    };
  }

  if (existing) copyFileSync(path, `${path}.pouch-backup`);
  writeFileSync(path, candidate);
  const added = toAdd.map((b) => b.key).join(", ");
  const skipped = clashing.length ? ` (skipped ${clashing.map((b) => b.key).join(", ")} — already bound)` : "";
  return { ok: true, what: "keys", detail: `added ${added} to ${path}${skipped}` };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function reload(): Promise<Step> {
  const { stderr, code } = await run([HERDR_BIN], ["server", "reload-config"]);
  if (code !== 0) return { ok: false, what: "reload", detail: `run \`herdr server reload-config\` yourself: ${stderr.trim()}` };
  return { ok: true, what: "reload", detail: "config reloaded — the keys work now" };
}

export interface SetupOptions {
  /** Skip touching config.toml, for an operator who binds their own keys. */
  keys: boolean;
}

/** Runs the whole onboarding and reports every step, failed ones included. */
export async function setup(options: SetupOptions = { keys: true }): Promise<Step[]> {
  const root = pluginRoot();
  const steps: Step[] = [await linkPlugin(root), installCli(root)];
  if (options.keys) {
    steps.push(await installKeys());
    // A rejected write means nothing to reload, and a reload would only add a
    // second error line about the same problem.
    if (steps[steps.length - 1]!.ok) steps.push(await reload());
  }
  return steps;
}

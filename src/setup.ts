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
import { runSafe } from "./runtime.ts";
import { herdrBin } from "./herdr.ts";

const HERDR_BIN = herdrBin();
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

/**
 * `plugin_action` hands the action id straight to Herdr. The older `shell` form
 * spawned `herdr plugin action invoke …` detached, which fails silently when the
 * key fires in an environment without `herdr` on PATH.
 */
function bindToml(bind: (typeof KEYBINDS)[number]): string {
  return [
    "[[keys.command]]",
    `key = "${bind.key}"`,
    'type = "plugin_action"',
    `command = "${PLUGIN_ID}.${bind.action}"`,
    `description = "${bind.description}"`,
  ].join("\n");
}

/** Matches either binding form, so an old block is recognised and replaced. */
function bindsAction(toml: string, action: string): boolean {
  return (
    toml.includes(`"${PLUGIN_ID}.${action}"`) ||
    toml.includes(`invoke ${action} --plugin ${PLUGIN_ID}`)
  );
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
  const { stdout, code } = await runSafe([HERDR_BIN], ["plugin", "list"]);
  return code === 0 && stdout.includes(PLUGIN_ID);
}

async function linkPlugin(root: string): Promise<Step> {
  if (await isLinked()) return { ok: true, what: "plugin", detail: `already linked (${PLUGIN_ID})` };
  const { stderr, code } = await runSafe([HERDR_BIN], ["plugin", "link", root]);
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

  // The managed block is dropped BEFORE deciding what is already bound. That is
  // what lets a re-run rewrite our own older `shell` bindings into
  // `plugin_action` ones, instead of seeing them and declaring the job done.
  const stripped = existing.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, "g"), "");
  const taken = boundKeys(stripped);

  const pending = KEYBINDS.filter((b) => !bindsAction(stripped, b.action));
  const clashing = pending.filter((b) => taken.has(b.key));
  const toAdd = pending.filter((b) => !taken.has(b.key));

  // A clash is the operator's own binding winning, not a failure: say which
  // action stayed unbound and leave their config alone.
  if (!toAdd.length) {
    // Bindings that reach our actions but sit outside the managed block are
    // hand-placed. Rewriting them would edit lines the operator owns, so the
    // old `shell` form is reported and left exactly where they put it.
    const handPlaced = KEYBINDS.filter((b) => stripped.includes(`invoke ${b.action} --plugin ${PLUGIN_ID}`));
    const notes = [
      ...clashing.map((b) => `${b.key} is yours, so \`${b.action}\` stays unbound`),
      ...(handPlaced.length
        ? [
            `${handPlaced.map((b) => b.key).join(", ")} use the old \`type = "shell"\` form outside Pouch's block — switch them to \`type = "plugin_action"\` with \`command = "${PLUGIN_ID}.<action>"\` yourself, or delete them and re-run`,
          ]
        : []),
    ];
    return { ok: true, what: "keys", detail: notes.length ? `already present — ${notes.join("; ")}` : "already present" };
  }

  const candidate = `${stripped.trimEnd()}\n\n${keysBlock(toAdd)}`;

  // Nothing to write when the rewrite is byte-identical — no backup churn.
  if (candidate === existing) return { ok: true, what: "keys", detail: "already present" };

  mkdirSync(dirname(path), { recursive: true });
  const probe = join(dirname(path), ".pouch-config-check.toml");
  writeFileSync(probe, candidate);
  const check = await runSafe([HERDR_BIN], ["config", "check"], { HERDR_CONFIG_PATH: probe });
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
  // Say "rewrote" when we replaced our own older block, so a re-run that appears
  // to change nothing still explains itself.
  const verb = existing.includes(BEGIN) ? "rewrote" : "added";
  return { ok: true, what: "keys", detail: `${verb} ${added} in ${path}${skipped}` };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function reload(): Promise<Step> {
  const { stderr, code } = await runSafe([HERDR_BIN], ["server", "reload-config"]);
  if (code !== 0) return { ok: false, what: "reload", detail: `run \`herdr server reload-config\` yourself: ${stderr.trim()}` };
  return { ok: true, what: "reload", detail: "config reloaded — the keys work now" };
}

export interface KeyState {
  key: string;
  action: string;
  /** `plugin_action` is current, `shell` is our pre-0.2.0 form, `operator` is theirs. */
  form: "plugin_action" | "shell" | "operator" | "absent";
}

export interface KeybindHealth {
  keys: KeyState[];
  /** Non-null when something needs the operator; the string names the remedy. */
  warning: string | null;
}

/**
 * Why a bound Pouch key can still do nothing.
 *
 * Herdr applies the FOREGROUND client's keybindings to the whole server, and a
 * client attached with `herdr --remote` sends a profile built by
 * `local_profile()`, which copies the built-in actions and drops every
 * `[[keys.command]]` entry. So built-in chords keep working while all three
 * Pouch keys go dead, which reads exactly like a broken plugin. Copying the
 * bindings to the connecting machine does not help — they are stripped there
 * too. Only `--remote-keybindings server` avoids it.
 *
 * There is no API that reports the foreground client's mode, so the attached
 * remote client is detected by its bridge process. A miss costs a missing hint,
 * never a wrong action.
 */
export async function keybindHealth(): Promise<KeybindHealth> {
  const path = configTomlPath();
  const toml = existsSync(path) ? readFileSync(path, "utf8") : "";
  const taken = boundKeys(toml);

  const keys: KeyState[] = KEYBINDS.map((bind) => {
    const form = toml.includes(`"${PLUGIN_ID}.${bind.action}"`)
      ? "plugin_action"
      : toml.includes(`invoke ${bind.action} --plugin ${PLUGIN_ID}`)
        ? "shell"
        : taken.has(bind.key)
          ? "operator"
          : "absent";
    return { key: bind.key, action: bind.action, form };
  });

  const missing = keys.filter((k) => k.form === "absent");
  if (missing.length) {
    return {
      keys,
      warning: `${missing.map((k) => k.key).join(", ")} not bound — run \`${BIN} setup\``,
    };
  }

  if (await remoteClientAttached()) {
    return {
      keys,
      warning:
        "a remote client is attached, and Herdr strips every [[keys.command]] binding from a remote client's profile — reattach with `herdr --remote <host> --remote-keybindings server`, or use the action menu",
    };
  }

  const stale = keys.filter((k) => k.form === "shell");
  if (stale.length) {
    return { keys, warning: `${stale.map((k) => k.key).join(", ")} still use the old shell form — run \`${BIN} setup\`` };
  }

  return { keys, warning: null };
}

/** An inbound remote client runs a bare `herdr remote-client-bridge` here. */
async function remoteClientAttached(): Promise<boolean> {
  try {
    const { stdout, code } = await runSafe(["ps"], ["-eo", "args"]);
    if (code !== 0) return false;
    return stdout.split("\n").some((line) => /herdr\s+remote-client-bridge\b/.test(line));
  } catch {
    return false;
  }
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

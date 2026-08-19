/** User config, read from $HERDR_PLUGIN_CONFIG_DIR/config.json (all keys optional). */

/**
 * The installed command name. Namespaced because `pouch` is a common enough
 * word to already be taken on someone's PATH.
 */
export const BIN = "herdr-pouch";

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface Config {
  /** Remove a message from the pouch once it has been inserted. */
  consumeOnInsert: boolean;
  /** Focus the agent pane after inserting, so Enter submits immediately. */
  focusAfterInsert: boolean;
  /** Widest a strip chip may get, in columns. */
  maxChipWidth: number;
  /** Milliseconds between pouch-file polls in the strip. */
  pollMs: number;
  /** Indicator mark. `{count}`, if present, is replaced with the message count. */
  indicator: string;
  /**
   * What `n` and `e` open. `builtin` is Pouch's own text box, `system` is
   * $VISUAL/$EDITOR, and anything else is run as a command with the temp file
   * appended. Default is builtin: Herdr starts plugin commands with a minimal
   * environment, so $EDITOR is often absent — and when it is present it is
   * whatever the operator's dotfiles say, which is no place to land by surprise.
   */
  editor: string;
}

const DEFAULTS: Config = {
  consumeOnInsert: false,
  focusAfterInsert: true,
  maxChipWidth: 34,
  pollMs: 500,
  indicator: "\u{1F45C}",
  editor: "builtin",
};

/** Mirrors Herdr's own plugin config layout — see the note on STATE_DIR. */
const HERDR_HOME = process.env.HERDR_CONFIG_PATH
  ? dirname(process.env.HERDR_CONFIG_PATH)
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(HERDR_HOME, "plugins", "config", "herdr.pouch");

export function loadConfig(): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8"));
  } catch {}
  const cfg = { ...DEFAULTS, ...fromFile };
  if (process.env.POUCH_CONSUME === "1") cfg.consumeOnInsert = true;
  if (process.env.POUCH_NO_FOCUS === "1") cfg.focusAfterInsert = false;
  if (process.env.POUCH_EDITOR) cfg.editor = process.env.POUCH_EDITOR;
  return cfg;
}

export const configPath = join(CONFIG_DIR, "config.json");

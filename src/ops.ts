/** Operations shared by the CLI and the plugin actions. */

import {
  openPluginPane,
  closePane,
  setPouchIndicator,
  getPane,
  getTab,
  renameTab,
  tryHerdr,
  sendText,
  focusPane,
} from "./herdr.ts";
import {
  loadPouch,
  readStrips,
  setStrip,
  readTabMarks,
  setTabMark,
  markUsed,
  type PouchTarget,
  type Message,
} from "./store.ts";
import { loadConfig } from "./config.ts";
import { sleep } from "./runtime.ts";

const PLUGIN_CWD = process.env.HERDR_PLUGIN_ROOT;

/** Pause between pasting text and pressing Enter for it. */
export const SUBMIT_SETTLE_MS = 150;

export const STRIP_ROWS = 3;

export async function openStrip(paneId: string, rows = STRIP_ROWS): Promise<string> {
  // Closing a pane doesn't tell us about it, so a recorded strip may be stale.
  const existing = readStrips()[paneId];
  if (existing) {
    if (await getPane(existing)) throw new Error(`a strip is already pinned under ${paneId} (${existing})`);
    setStrip(paneId, null);
  }
  const stripPane = await openPluginPane("strip", {
    placement: "split",
    targetPane: paneId,
    direction: "down",
    env: { POUCH_TARGET_PANE: paneId },
    cwd: PLUGIN_CWD,
    focus: false,
  });
  if (!stripPane) throw new Error("herdr did not report a pane id for the strip");
  setStrip(paneId, stripPane);
  await shrinkTo(stripPane, rows);
  return stripPane;
}

/**
 * A fresh split lands at 50/50 and `plugin pane open` refuses a size for
 * non-popup placements, so the strip has to be squeezed down afterwards.
 * `pane resize --amount` is a fraction of the containing split, which we only
 * know approximately — so converge instead of computing once.
 */
async function shrinkTo(stripPane: string, rows: number) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const strip = await getPane(stripPane);
    if (!strip) return;
    const current = strip.scroll?.viewport_rows ?? 0;
    if (current <= rows) return;
    const sibling = await getPane(readSiblingOf(stripPane));
    const total = current + (sibling?.scroll?.viewport_rows ?? current);
    const amount = Math.min(0.9, Math.max(0.01, (current - rows) / Math.max(1, total)));
    const before = current;
    await tryHerdr("pane", "resize", "--pane", stripPane, "--direction", "down", "--amount", amount.toFixed(3));
    const after = (await getPane(stripPane))?.scroll?.viewport_rows ?? before;
    if (after >= before) return; // Herdr refused to shrink further; take what we got.
  }
}

/** The agent pane a strip is pinned under, from the strips bookkeeping file. */
function readSiblingOf(stripPane: string): string {
  const entry = Object.entries(readStrips()).find(([, strip]) => strip === stripPane);
  return entry?.[0] ?? stripPane;
}

export async function closeStrip(paneId: string): Promise<string> {
  const stripPane = readStrips()[paneId];
  if (!stripPane) throw new Error(`no strip pinned under ${paneId}`);
  await closePane(stripPane);
  setStrip(paneId, null);
  return stripPane;
}

/**
 * Popup height in cells, sized to the pouch: header, one row per message up to
 * a dozen, a detail block, and the button and help rows. A flat percentage
 * leaves a two-message pouch swimming in empty rows.
 */
const popupRows = (count: number): string => String(18 + Math.min(Math.max(count, 1), 12));

export type PopupMode = "compose" | "browse";

/**
 * Herdr allows exactly one popup per session, so a second `open` fails rather
 * than stacking. Translate that into something a user can act on.
 */
export async function openPopup(target: PouchTarget | null, mode?: PopupMode) {
  // A popup needs no host pane, so a pouch whose agent is gone still opens —
  // it just has no default insert destination until one is picked.
  const env: Record<string, string> = {};
  if (target) env.POUCH_TARGET_KEY = target.key;
  if (target?.paneId) env.POUCH_TARGET_PANE = target.paneId;
  if (mode) env.POUCH_MODE = mode;
  try {
    return await openPluginPane("list", {
      placement: "popup",
      width: "70%",
      height: popupRows(target ? (loadPouch(target.key)?.messages.length ?? 0) : 12),
      env,
      cwd: PLUGIN_CWD,
      focus: true,
    });
  } catch (err) {
    if ((err as Error).message.includes("popup already open")) {
      throw new Error("a popup is already open — close it with esc first");
    }
    throw err;
  }
}

/**
 * Inserts the pouch's first message into its pane. This is the fast path behind
 * the global insert bindings, which have no UI to report through — the caller
 * gets a reason back so it can decide whether to notify.
 */
export async function insertFirst(
  target: PouchTarget,
  opts: { submit?: boolean; focus?: boolean; to?: string } = {},
): Promise<{ inserted: Message } | { reason: string }> {
  // `to` aims a pouch at a pane other than its own — the only way to spend a
  // pouch whose agent has been closed.
  const paneId = opts.to ?? target.paneId;
  if (!paneId) return { reason: `${target.label} has no live pane — pass --to <pane>` };
  const first = loadPouch(target.key)?.messages[0];
  if (!first) return { reason: `${target.label}'s pouch is empty` };

  await sendText(paneId, first.text);
  if (opts.submit) {
    // Agent input widgets ingest a bracketed paste asynchronously; an Enter sent
    // in the same breath can land before the text is in the buffer and submit an
    // empty line instead.
    await sleep(SUBMIT_SETTLE_MS);
    await tryHerdr("pane", "send-keys", paneId, "enter");
  }

  const cfg = loadConfig();
  // Submitting is not consuming. Whether an inserted message leaves the pouch is
  // `consumeOnInsert`'s call alone — forcing it here ate messages that the
  // operator had configured Pouch to keep.
  markUsed(target.key, first.id, cfg.consumeOnInsert);
  await syncIndicator(target);
  if (opts.focus ?? cfg.focusAfterInsert) await focusPane(paneId);
  return { inserted: first };
}

/**
 * Keeps every indicator surface in step with the pouch.
 *
 * Herdr only draws a border around *split* panes, so a pane alone in its tab
 * has no chrome to paint on. In that case the mark moves to the tab label,
 * which the tab bar always shows. Splitting the tab hands it back to the
 * border and cleans the label up again.
 */
export async function syncIndicator(target: PouchTarget) {
  if (!target.paneId) return;
  const count = loadPouch(target.key)?.messages.length ?? 0;
  const { indicator } = loadConfig();

  await setPouchIndicator(target.paneId, count, indicator);

  const pane = await getPane(target.paneId);
  if (!pane) return;
  const tab = await getTab(pane.tab_id);
  if (!tab) return;

  const label = tab.label ?? "";
  const base = stripMark(label, indicator, readTabMarks()[tab.tab_id]);
  const wanted =
    count > 0 && tab.pane_count < 2 ? `${base} ${mark(count, indicator)}`.trim() : base;

  if (wanted !== label) await renameTab(tab.tab_id, wanted);
  setTabMark(tab.tab_id, wanted === base ? null : wanted.slice(base.length).trim());
}

const mark = (count: number, indicator: string) => indicator.replaceAll("{count}", String(count));

/**
 * Removes a mark we appended earlier. `applied` is what we last wrote, which is
 * the only reliable way to strip a mark left by a since-changed indicator; the
 * pattern derived from the current config is a fallback for state we lost.
 */
function stripMark(label: string, indicator: string, applied?: string): string {
  let out = label;
  if (applied && out.endsWith(applied)) out = out.slice(0, -applied.length);
  const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\{count\\}", "\\d*");
  const pattern = new RegExp(`\\s*${escaped}\\d*\\s*$`);
  for (let guard = 0; guard < 8 && pattern.test(out); guard++) out = out.replace(pattern, "");
  return out.trim();
}

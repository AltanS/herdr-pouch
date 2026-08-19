/**
 * The pouch strip: a three-row plugin pane pinned under an agent pane.
 *
 * Herdr owns pane chrome and the agent owns its own screen, so this is the only
 * place a plugin can legitimately draw. The strip is mouse-first — click the
 * pouch to open the full list, click a chip to drop that message into the
 * agent's input.
 *
 * Requires POUCH_TARGET_PANE in the environment; scripts/pouch-ctl.sh sets it.
 */

import { Screen, style, oneLine, truncate } from "./tui.ts";
import { smallPouch, tinyPouch, SMALL_WIDTH, TINY_WIDTH } from "./art.ts";
import { loadConfig, BIN } from "./config.ts";
import { getPane, sendText, focusPane } from "./herdr.ts";
import { openPopup, syncIndicator } from "./ops.ts";
import {
  resolveTarget,
  loadPouch,
  pouchMtime,
  markUsed,
  type Message,
  type PouchTarget,
} from "./store.ts";

type Hit = { kind: "insert"; id: string } | { kind: "list" } | { kind: "compose" } | { kind: "more" };

const cfg = loadConfig();
const targetPaneId = process.env.POUCH_TARGET_PANE;
if (!targetPaneId) {
  console.error("pouch strip: POUCH_TARGET_PANE is not set — open the strip with the `attach` action");
  process.exit(2);
}

const screen = new Screen<Hit>();
let target: PouchTarget = await resolveTarget(targetPaneId);
let messages: Message[] = loadPouch(target.key)?.messages ?? [];
let flash: { text: string; until: number } | null = null;
let lastMtime = pouchMtime(target.key);

// --- rendering ---------------------------------------------------------------

function render() {
  const { cols, rows } = screen;
  screen.begin();

  const empty = messages.length === 0;
  const tinyArt = rows < 3 || cols < 40;
  let x0: number;

  if (tinyArt) {
    screen.clickable(0, 0, style.bold + tinyPouch(messages.length) + style.reset, TINY_WIDTH, { kind: "list" });
    x0 = TINY_WIDTH + 1;
  } else {
    const art = smallPouch(messages.length);
    art.forEach((line, i) => {
      screen.clickable(i, 0, (empty ? style.dim : style.bold) + line + style.reset, SMALL_WIDTH, { kind: "list" });
    });
    x0 = SMALL_WIDTH + 2;
  }

  const width = cols - x0;
  // The bottom row is the button bar; everything above it holds chips. A
  // single-row strip has no room for buttons, so chips take the whole row.
  const buttonRow = rows >= 2 ? rows - 1 : -1;
  const chipRows = Array.from({ length: buttonRow < 0 ? 1 : buttonRow }, (_, i) => i);

  if (empty) {
    screen.at(chipRows[0]!, x0, style.dim + truncate("pouch is empty", width) + style.reset);
    if (chipRows.length > 1) {
      screen.at(
        chipRows[1]!,
        x0,
        style.dim + truncate(`stash one:  ${BIN} add --pane ${target.paneId ?? targetPaneId} "…"`, width) + style.reset,
      );
    }
  } else {
    drawChips(chipRows, x0, width);
  }

  drawButtons(buttonRow, x0, width);
  screen.end();
}

function drawChips(chipRows: number[], x0: number, width: number) {
  let row = 0;
  let cursor = x0;
  let placed = 0;

  for (const [i, msg] of messages.entries()) {
    const label = `[${i + 1}] ${oneLine(msg.text)}`;
    const chipWidth = Math.min(label.length, cfg.maxChipWidth, width);
    if (cursor + chipWidth > x0 + width) {
      row += 1;
      cursor = x0;
    }
    if (row >= chipRows.length) break;
    const targetRow = chipRows[row]!;

    const fresh = msg.uses === 0;
    const text = truncate(label, chipWidth);
    screen.clickable(
      targetRow,
      cursor,
      (fresh ? style.cyan : style.dim) + text + style.reset,
      chipWidth,
      { kind: "insert", id: msg.id },
    );
    cursor += chipWidth + 2;
    placed += 1;
  }

  const hidden = messages.length - placed;
  if (hidden > 0) {
    const label = `+${hidden} more`;
    const lastRow = chipRows[Math.min(row, chipRows.length - 1)]!;
    const col = Math.max(x0, screen.cols - label.length);
    screen.clickable(lastRow, col, style.dim + label + style.reset, label.length, { kind: "more" });
  }
}

function drawButtons(row: number, x0: number, width: number) {
  if (row < 0) return;
  let cursor = x0;
  const add = " + add ";
  const list = " ≡ list ";
  screen.clickable(row, cursor, style.reverse + add + style.reset, add.length, { kind: "compose" });
  cursor += add.length + 1;
  screen.clickable(row, cursor, style.reverse + list + style.reset, list.length, { kind: "list" });
  cursor += list.length + 2;

  const note =
    flash && flash.until > Date.now()
      ? style.green + flash.text + style.reset
      : style.dim + "1-9 insert · n new · l list · q close" + style.reset;
  const plain = note.replace(/\x1b\[[0-9;]*m/g, "");
  if (cursor + plain.length <= x0 + width) {
    screen.at(row, x0 + width - plain.length, note);
  }
}

// --- actions -----------------------------------------------------------------

function setFlash(text: string) {
  flash = { text, until: Date.now() + 2000 };
  render();
  setTimeout(() => {
    if (flash && flash.until <= Date.now()) {
      flash = null;
      render();
    }
  }, 2100);
}

async function insert(id: string) {
  const msg = loadPouch(target.key)?.messages.find((m) => m.id === id);
  if (!msg) return;
  const paneId = target.paneId ?? targetPaneId!;
  try {
    await sendText(paneId, msg.text);
  } catch (err) {
    setFlash(`✗ ${(err as Error).message.slice(0, 40)}`);
    return;
  }
  markUsed(target.key, id, cfg.consumeOnInsert);
  await refresh(true);
  setFlash(`→ inserted into ${paneId}`);
  if (cfg.focusAfterInsert) await focusPane(paneId);
}

async function insertSlot(n: number) {
  const msg = messages[n - 1];
  if (msg) await insert(msg.id);
}

const openList = (mode?: "compose") =>
  openPopup({ ...target, paneId: target.paneId ?? targetPaneId! }, mode).catch((err) =>
    setFlash(`✗ ${(err as Error).message.slice(0, 48)}`),
  );

// --- polling -----------------------------------------------------------------

async function refresh(force = false) {
  const mtime = pouchMtime(target.key);
  if (!force && mtime === lastMtime) return false;
  lastMtime = mtime;
  messages = loadPouch(target.key)?.messages ?? [];
  await syncIndicator({ ...target, paneId: target.paneId ?? targetPaneId! });
  render();
  return true;
}

/** The strip is meaningless without its agent pane; follow it out. */
async function checkAlive() {
  const paneId = target.paneId ?? targetPaneId!;
  if (await getPane(paneId)) return;
  // Re-resolve once: the pane may have moved and been given a new id.
  try {
    target = await resolveTarget(paneId);
    if (target.paneId) return;
  } catch {}
  screen.leave();
  process.exit(0);
}

// --- main loop ---------------------------------------------------------------

screen.enter();
await refresh(true);
render();

setInterval(() => void refresh(), cfg.pollMs);
setInterval(() => void checkAlive(), 3000);
process.stdout.on("resize", render);

for await (const ev of screen.input()) {
  if (ev.type === "click") {
    const hit = screen.hit(ev.row, ev.col);
    if (hit?.kind === "insert") await insert(hit.id);
    else if (hit?.kind === "compose") await openList("compose");
    else if (hit?.kind === "list" || hit?.kind === "more") await openList();
    continue;
  }
  if (ev.type === "char") {
    if (ev.value >= "1" && ev.value <= "9") await insertSlot(Number(ev.value));
    else if (ev.value === "n" || ev.value === "a") await openList("compose");
    else if (ev.value === "l" || ev.value === " ") await openList();
    else if (ev.value === "r") await refresh(true);
    else if (ev.value === "q" || ev.value === "\x03") {
      screen.leave();
      process.exit(0);
    }
  }
}

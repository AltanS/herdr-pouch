/**
 * The full pouch, opened as a popup plugin pane.
 *
 * Browse, filter, compose, edit, reorder and insert. Composing and editing hand
 * off to $EDITOR — this is a real terminal, so there is no reason to
 * reimplement one.
 *
 * Opens on POUCH_TARGET_PANE when its pane is alive, otherwise on POUCH_TARGET_KEY.
 * Neither is required in POUCH_MODE=browse, which starts on the pouch picker —
 * that is the only way back into a pouch whose agent has been closed.
 * POUCH_MODE=compose opens straight into a new message.
 */

import { unlinkSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Screen, style, oneLine, truncate, ago, wrap, pad } from "./tui.ts";
import { bigPouch, BIG_WIDTH } from "./art.ts";
import { loadConfig, BIN } from "./config.ts";
import { syncIndicator } from "./ops.ts";
import { runInteractive } from "./runtime.ts";
import {
  fromText,
  toText,
  layout,
  insert as typeText,
  newline as splitLine,
  backspace as deleteBack,
  move as moveCursor,
  place,
  type Buffer as TextBuffer,
  type VisualRow,
} from "./editor.ts";
import { sendText, focusPane, listPanes } from "./herdr.ts";
import {
  resolveTarget,
  loadPouch,
  allPouches,
  livePanesByKey,
  readStrips,
  targetFromPouch,
  addMessage,
  removeMessage,
  updateMessage,
  moveMessage,
  markUsed,
  type Message,
  type PouchTarget,
} from "./store.ts";

type Hit =
  | { kind: "row"; id: string }
  | { kind: "pick"; index: number }
  | { kind: "insert" }
  | { kind: "new" }
  | { kind: "edit" }
  | { kind: "delete" }
  | { kind: "text"; index: number }
  | { kind: "close" };

const cfg = loadConfig();
const openMode = process.env.POUCH_MODE;
const targetPaneId = process.env.POUCH_TARGET_PANE;
const targetKey = process.env.POUCH_TARGET_KEY;

const screen = new Screen<Hit>();

/** The pouch on screen. Null only until the picker is answered in browse mode. */
let target: PouchTarget | null = null;
if (targetPaneId) target = await resolveTarget(targetPaneId).catch(() => null);
if (!target && targetKey) {
  const saved = loadPouch(targetKey);
  if (saved) target = await targetFromPouch(saved);
}
if (!target && openMode !== "browse") {
  console.error("pouch: nothing to open — use the `open` action, or `browse` to pick a pouch");
  process.exit(2);
}

/**
 * Where insert sends text. It starts as the pouch's own pane and stays null
 * when that pane is gone — a pouch with no agent is still readable, editable
 * and insertable, it just has to be told where to.
 */
let dest: string | null = target?.paneId ?? null;

let messages: Message[] = target ? (loadPouch(target.key)?.messages ?? []) : [];
let selected = 0;
let filter = "";
let filtering = false;
let status: string | null = null;
let confirmDelete = false;

/**
 * A modal chooser drawn over the pouch: which pouch to show, or which pane to
 * insert into. One shape serves both because both are "pick a row, run this".
 */
interface Picker {
  title: string;
  empty: string;
  rows: { label: string; detail: string }[];
  index: number;
  choose: (index: number) => Promise<void>;
  cancel?: () => void;
}
// Written as an assertion rather than `: Picker | null = null`, so this
// top-level scope doesn't keep it narrowed to null: every assignment happens
// inside a function, which control-flow analysis here cannot see.
let picker = null as Picker | null;

/**
 * The built-in editor, when it is open. Modal like the picker, and for the same
 * reason: there is one stdin, so a nested read loop would fight the main one.
 */
interface Composer {
  title: string;
  buffer: TextBuffer;
  save: (text: string) => Promise<void>;
  /** esc discards work, so it asks once before it does. */
  confirmDiscard: boolean;
}
let composer = null as Composer | null;

/** The last frame's wrapped rows, so a click can be mapped back to an offset. */
let composerRows: VisualRow[] = [];

/** The list as currently filtered. Selection and slot numbers index this. */
function view(): Message[] {
  if (!filter) return messages;
  const needle = filter.toLowerCase();
  return messages.filter((m) => m.text.toLowerCase().includes(needle));
}

const current = (): Message | undefined => view()[selected];

function reload(keepId?: string) {
  messages = target ? (loadPouch(target.key)?.messages ?? []) : [];
  const rows = view();
  const at = keepId ? rows.findIndex((m) => m.id === keepId) : -1;
  selected = at >= 0 ? at : Math.min(selected, Math.max(0, rows.length - 1));
}

const sync = async () => {
  if (target) await syncIndicator(target);
};

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

// --- rendering ---------------------------------------------------------------

function render() {
  const { cols, rows } = screen;
  screen.begin();
  if (composer) drawComposer(composer, cols, rows);
  else if (picker) drawPicker(picker, cols, rows);
  else drawPouch(cols, rows);
  screen.end();
}

function drawPicker(open: Picker, cols: number, rows: number) {
  const width = cols - 4;
  screen.at(1, 2, `${style.bold}${truncate(open.title, width)}${style.reset}`);
  rule(2, cols);
  if (!open.rows.length) {
    screen.at(4, 3, `${style.dim}${open.empty}${style.reset}`);
    screen.at(rows - 1, 2, `${style.dim}esc close${style.reset}`);
    return;
  }
  const top = 4;
  const height = Math.max(1, rows - top - 2);
  const start = Math.max(0, Math.min(open.index - Math.floor(height / 2), open.rows.length - height));
  // One label column for the whole list, so the details line up as a column too.
  const labelWidth = Math.min(30, Math.max(...open.rows.map((r) => r.label.length)));
  const detailRoom = Math.max(0, width - labelWidth - 4);
  open.rows.slice(start, start + height).forEach((row, i) => {
    const index = start + i;
    const line = ` ${pad(truncate(row.label, labelWidth), labelWidth)}  ${truncate(row.detail, detailRoom)} `;
    screen.clickable(top + i, 2, (index === open.index ? style.reverse : "") + pad(line, width) + style.reset, width, {
      kind: "pick",
      index,
    });
  });
  screen.at(rows - 1, 2, `${style.dim}↑↓ move · enter choose · esc back${style.reset}`);
}

function drawComposer(open: Composer, cols: number, rows: number) {
  const width = Math.max(10, cols - 4);
  const top = 4;
  const height = Math.max(1, rows - top - 2);

  screen.at(1, 2, `${style.bold}${truncate(open.title, width)}${style.reset}`);
  rule(2, cols);

  const view = layout(open.buffer, width);
  composerRows = view.rows;
  // Scroll only far enough to keep the cursor on screen: a message is short,
  // and a box that jumps around while typing is worse than one that sits still.
  const start = Math.max(0, Math.min(view.cursorRow - height + 1, view.rows.length - height));
  const from = Math.max(0, start);

  view.rows.slice(from, from + height).forEach((row, i) => {
    screen.clickable(top + i, 2, pad(row.text, width), width, { kind: "text", index: from + i });
  });

  // The terminal cursor is hidden for the whole TUI, so the caret is painted:
  // the character under it in reverse video, or a reversed space at line end.
  const caretRow = view.cursorRow - from;
  if (caretRow >= 0 && caretRow < height) {
    const under = view.rows[view.cursorRow]?.text[view.cursorCol] ?? " ";
    screen.at(top + caretRow, 2 + view.cursorCol, `${style.reverse}${under}${style.reset}`);
  }

  const chars = toText(open.buffer).trim().length;
  const help = open.confirmDiscard
    ? `${style.yellow}esc again to discard${style.reset}`
    : `${style.dim}ctrl-s save · esc cancel · enter new line · ${chars} chars${style.reset}`;
  screen.at(rows - 1, 2, help);
}

function drawPouch(cols: number, rows: number) {
  drawHeader(cols);

  const helpRow = rows - 1;
  const buttonRow = rows - 2;
  const listTop = 6;
  const lastContentRow = buttonRow - 2;
  const rowsInView = view();

  if (messages.length === 0) {
    screen.at(listTop, 3, `${style.dim}The pouch is empty.${style.reset}`);
    screen.at(listTop + 1, 3, `${style.dim}Press n to write a message, or run:${style.reset}`);
    screen.at(listTop + 2, 3, `${style.dim}  ${BIN} add --agent ${target?.label ?? "…"} "…"${style.reset}`);
  } else if (rowsInView.length === 0) {
    rule(listTop - 1, cols);
    screen.at(listTop, 3, `${style.dim}No message matches "${filter}".${style.reset}`);
  } else {
    // The list hugs its content and the detail sits directly beneath it, so
    // slack collects at the bottom next to the buttons rather than as a hole in
    // the middle of the panel.
    const maxList = Math.max(1, lastContentRow - listTop - 2);
    const listRows = Math.min(rowsInView.length, maxList);
    rule(listTop - 1, cols);
    drawRows(rowsInView, listTop, listRows, cols);

    const detailTop = listTop + listRows + 1;
    const detailRoom = lastContentRow - detailTop + 1;
    if (detailRoom > 0) {
      rule(detailTop - 1, cols);
      drawDetail(detailTop, detailRoom, cols - 4);
    }
  }

  drawButtons(buttonRow, cols);
  drawFooter(helpRow, cols);
}

const rule = (row: number, cols: number) =>
  screen.at(row, 2, `${style.dim}${"─".repeat(Math.max(0, cols - 4))}${style.reset}`);

function drawHeader(cols: number) {
  const art = bigPouch(messages.length);
  art.forEach((line, i) => screen.at(i + 1, 2, (messages.length ? style.bold : style.dim) + line + style.reset));

  const col = BIG_WIDTH + 4;
  const room = Math.max(10, cols - col - 2);
  const count = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  screen.at(1, col, `${style.bold}${truncate(target?.label ?? "no pouch", room)}${style.reset}`);
  // The destination is spelled out rather than assumed: this pouch's own agent
  // may be gone, or the operator may have aimed it somewhere else entirely.
  if (dest) {
    screen.at(2, col, `${style.dim}${truncate(`${count}  →  ${dest}`, room)}${style.reset}`);
  } else {
    const note = truncate("no live pane — press I", Math.max(0, room - count.length - 2));
    screen.at(2, col, `${style.dim}${count}${style.reset}  ${style.yellow}${note}${style.reset}`);
  }
  screen.at(3, col, `${style.dim}${truncate(tilde(target?.cwd ?? ""), room)}${style.reset}`);
}

function drawRows(rowsInView: Message[], top: number, height: number, cols: number) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), rowsInView.length - height));
  const width = cols - 4;

  rowsInView.slice(start, start + height).forEach((msg, i) => {
    const index = start + i;
    const active = index === selected;
    const slot = index < 9 ? `${index + 1}` : " ";
    const age = ago(msg.createdAt) + (msg.uses ? ` ·${msg.uses}×` : "");
    const textRoom = Math.max(4, width - 6 - age.length);
    const line = ` ${slot}  ${pad(truncate(oneLine(msg.text), textRoom), textRoom)}  ${age} `;

    screen.clickable(
      top + i,
      2,
      (active ? style.reverse : msg.uses ? style.dim : "") + pad(line, width) + style.reset,
      width,
      { kind: "row", id: msg.id },
    );
  });
}

function drawDetail(top: number, height: number, inner: number) {
  const msg = current();
  if (!msg) return;
  const lines = wrap(msg.text, inner - 2);
  lines.slice(0, height).forEach((line, i) => screen.at(top + i, 3, line));
  if (lines.length > height) screen.at(top + height - 1, 3, `${style.dim}…${style.reset}`);
}

function drawButtons(row: number, cols: number) {
  const buttons: [string, Hit][] = [
    [" insert ", { kind: "insert" }],
    [" new ", { kind: "new" }],
    [" edit ", { kind: "edit" }],
    [" delete ", { kind: "delete" }],
    [" close ", { kind: "close" }],
  ];
  let cursor = 2;
  for (const [label, hit] of buttons) {
    if (cursor + label.length >= cols - 1) break;
    screen.clickable(row, cursor, style.reverse + label + style.reset, label.length, hit);
    cursor += label.length + 2;
  }
}

const LONG_HELP =
  "↑↓ move · 1-9 insert · enter insert+close · / filter · y copy · n new · e edit · d delete · J/K reorder · p pouches · I target · q close";
const SHORT_HELP = "↑↓ · 1-9 insert · / filter · p pouches · I target · q close";

function drawFooter(row: number, cols: number) {
  const width = cols - 4;
  if (filtering) {
    screen.at(row, 2, `${style.bold}/${filter}▏${style.reset}${style.dim}  esc clear · enter keep${style.reset}`);
    return;
  }
  if (confirmDelete) {
    screen.at(row, 2, `${style.red}delete this message? y / n${style.reset}`);
    return;
  }
  if (status) {
    screen.at(row, 2, `${style.green}${truncate(status, width)}${style.reset}`);
    return;
  }
  const badge = filter ? `${style.bold}/${filter}${style.reset}  ` : "";
  const room = width - (filter ? filter.length + 3 : 0);
  const help = LONG_HELP.length <= room ? LONG_HELP : SHORT_HELP;
  screen.at(row, 2, `${badge}${style.dim}${truncate(help, room)}${style.reset}`);
}

// --- actions -----------------------------------------------------------------

function flash(text: string) {
  status = text;
  render();
  setTimeout(() => {
    status = null;
    render();
  }, 1800);
}

async function insert(msg: Message | undefined, close: boolean) {
  if (!msg || !target) return;
  // No destination means the pouch outlived its agent: ask where to put it
  // rather than failing, and carry the pending insert through the picker.
  if (!dest) {
    await openPanePicker(msg, close);
    return;
  }
  const to = dest;
  try {
    await sendText(to, msg.text);
  } catch (err) {
    flash(`✗ ${(err as Error).message}`);
    return;
  }
  markUsed(target.key, msg.id, cfg.consumeOnInsert);
  reload(msg.id);
  await sync();
  if (close) {
    screen.leave();
    if (cfg.focusAfterInsert) await focusPane(to);
    process.exit(0);
  }
  flash(`→ inserted into ${to}`);
}

// --- pickers -----------------------------------------------------------------

/**
 * Every pouch on disk, live agent or not. This is the way back into a pouch
 * whose pane was closed — nothing else in the UI can name one.
 */
async function openPouchPicker() {
  const live = await livePanesByKey();
  const pouches = allPouches().sort((a, b) => a.label.localeCompare(b.label));
  picker = {
    title: "Pouches",
    empty: `Nothing stashed anywhere yet. Try ${BIN} add "…"`,
    index: Math.max(0, pouches.findIndex((p) => p.key === target?.key)),
    rows: pouches.map((p) => {
      const count = `${p.messages.length} msg${p.messages.length === 1 ? "" : "s"}`;
      const pane = live.get(p.key);
      return { label: p.label, detail: `${count}   ${pane ?? "no live pane"}   ${tilde(p.cwd)}` };
    }),
    choose: async (index) => {
      const pouch = pouches[index];
      if (!pouch) return;
      target = await targetFromPouch(pouch, live);
      dest = target.paneId;
      picker = null;
      filter = "";
      selected = 0;
      reload();
      await sync();
      render();
    },
    // Browse mode starts here with no pouch behind the picker, so backing out
    // of it has nothing to fall back to.
    cancel: target ? undefined : () => process.exit(0),
  };
  render();
}

/** Aims this pouch at any open pane, optionally finishing a pending insert. */
async function openPanePicker(pending?: Message, close = false) {
  // Our own panes are not destinations: this popup, and any pouch strip — both
  // would just swallow the text as keystrokes.
  const ours = new Set([process.env.HERDR_PANE_ID, ...Object.values(readStrips())]);
  const panes = (await listPanes()).filter((p) => !ours.has(p.pane_id));
  picker = {
    title: pending ? "Insert into…" : "Send this pouch to…",
    empty: "No panes open.",
    index: Math.max(0, panes.findIndex((p) => p.pane_id === dest)),
    rows: panes.map((p) => ({
      label: p.agent ?? p.label ?? "shell",
      detail: `${p.pane_id}   ${tilde(p.cwd ?? "")}`,
    })),
    choose: async (index) => {
      const pane = panes[index];
      if (!pane) return;
      dest = pane.pane_id;
      picker = null;
      if (pending) await insert(pending, close);
      else flash(`→ aimed at ${pane.pane_id}`);
    },
  };
  render();
}

/** OSC 52 — hands the text to whatever clipboard the outer terminal owns. */
function copy(msg: Message | undefined) {
  if (!msg) return;
  const payload = Buffer.from(msg.text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${payload}\x07`);
  flash(`⧉ copied ${msg.text.length} chars`);
}

/**
 * Drops out of the alt screen, runs an external editor on a temp file and comes
 * back. Returns null when the operator saved nothing.
 */
async function editExternal(initial: string, command: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "pouch-"));
  const file = join(dir, "message.md");
  writeFileSync(file, initial);
  screen.leave();
  await runInteractive(["sh", "-c", `${command} "$1"`, "sh", file]);
  screen.enter();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  try {
    unlinkSync(file);
  } catch {}
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Which editor `n` and `e` open. `builtin` is the box below; `system` is the
 * operator's $VISUAL/$EDITOR; anything else is run as a command.
 */
function externalCommand(): string | null {
  const setting = cfg.editor.trim();
  if (!setting || setting === "builtin") return null;
  if (setting === "system") return process.env.VISUAL || process.env.EDITOR || "vi";
  return setting;
}

async function openEditor(initial: string, title: string, save: (text: string) => Promise<void>) {
  const command = externalCommand();
  if (!command) {
    composer = { title, buffer: fromText(initial), save, confirmDiscard: false };
    render();
    return;
  }
  const text = await editExternal(initial, command);
  if (!text) {
    render();
    return;
  }
  await save(text);
}

async function compose() {
  if (!target) return;
  await openEditor("", "new message", async (text) => {
    const msg = addMessage(target!, text);
    filter = "";
    reload(msg.id);
    await sync();
    flash("＋ stashed");
  });
}

async function editSelected() {
  const msg = current();
  if (!msg || !target) return;
  await openEditor(msg.text, "edit message", async (text) => {
    updateMessage(target!.key, msg.id, text);
    reload(msg.id);
    flash("✎ updated");
  });
}

async function deleteSelected() {
  const msg = current();
  if (!msg || !target) return;
  removeMessage(target.key, msg.id);
  reload();
  await sync();
  flash("✕ removed");
}

function reorder(delta: number) {
  const msg = current();
  if (!msg || !target) return;
  if (filter) {
    flash("clear the filter before reordering");
    return;
  }
  if (moveMessage(target.key, msg.id, delta)) {
    reload(msg.id);
    render();
  }
}

const move = (delta: number) => {
  selected = Math.max(0, Math.min(view().length - 1, selected + delta));
  render();
};

// --- main loop ---------------------------------------------------------------

screen.enter();
render();
process.stdout.on("resize", render);

if (openMode === "browse" || !target) await openPouchPicker();
else if (openMode === "compose") await compose();

for await (const ev of screen.input()) {
  // The editor is modal and owns everything, printable keys most of all: a
  // shortcut firing mid-sentence would be indistinguishable from a typo.
  const writing = composer;
  if (writing) {
    const done = async (text: string | null) => {
      composer = null;
      composerRows = [];
      if (text) await writing.save(text);
      render();
    };
    const dismiss = async () => {
      // An empty box has nothing to lose, so it closes on the first esc.
      if (!toText(writing.buffer).trim() || writing.confirmDiscard) return done(null);
      writing.confirmDiscard = true;
      render();
    };
    // Any key that is not the second esc takes the warning back off screen.
    const keepsWarning = ev.type === "key" && ev.value === "esc";
    if (writing.confirmDiscard && !keepsWarning) writing.confirmDiscard = false;

    if (ev.type === "click") {
      const hit = screen.hit(ev.row, ev.col);
      if (hit?.kind === "text") {
        place(writing.buffer, composerRows, hit.index, ev.col - 2);
        render();
      }
    } else if (ev.type === "key") {
      if (ev.value === "enter") splitLine(writing.buffer);
      else if (ev.value === "backspace") deleteBack(writing.buffer);
      else if (ev.value === "esc") {
        await dismiss();
        continue;
      } else if (ev.value === "tab") typeText(writing.buffer, "  ");
      else moveCursor(writing.buffer, ev.value);
      render();
    } else if (ev.type === "char") {
      if (ev.value === "\x13" || ev.value === "\x04") {
        await done(toText(writing.buffer).trim() || null);
        continue;
      }
      if (ev.value === "\x03") {
        await done(null);
        continue;
      }
      typeText(writing.buffer, ev.value);
      render();
    }
    continue;
  }

  // A picker is modal: it owns every key and click until it is answered.
  const open = picker;
  if (open) {
    const move = (delta: number) => {
      open.index = Math.max(0, Math.min(open.rows.length - 1, open.index + delta));
      render();
    };
    const dismiss = () => {
      picker = null;
      if (open.cancel) open.cancel();
      else render();
    };
    if (ev.type === "click") {
      const hit = screen.hit(ev.row, ev.col);
      if (hit?.kind === "pick") {
        // First click selects, a second on the same row commits — the same
        // two-step the message list uses, so a stray click is never destructive.
        if (hit.index === open.index) await open.choose(open.index);
        else {
          open.index = hit.index;
          render();
        }
      }
    } else if (ev.type === "scroll") move(ev.direction === "up" ? -1 : 1);
    else if (ev.type === "key") {
      if (ev.value === "up") move(-1);
      else if (ev.value === "down") move(1);
      else if (ev.value === "enter") await open.choose(open.index);
      else if (ev.value === "esc") dismiss();
    } else if (ev.type === "char") {
      if (ev.value === "k") move(-1);
      else if (ev.value === "j") move(1);
      else if (ev.value === "q" || ev.value === "\x03") dismiss();
    }
    continue;
  }

  // While the filter is open it owns the keyboard, so typed letters go into the
  // query instead of firing shortcuts.
  if (filtering) {
    if (ev.type === "char" && ev.value === "\x03") {
      filtering = false;
      filter = "";
      render();
    } else if (ev.type === "char") {
      filter += ev.value;
      selected = 0;
      render();
    } else if (ev.type === "key" && ev.value === "backspace") {
      filter = filter.slice(0, -1);
      selected = 0;
      render();
    } else if (ev.type === "key" && (ev.value === "enter" || ev.value === "esc")) {
      if (ev.value === "esc") filter = "";
      filtering = false;
      selected = 0;
      render();
    }
    continue;
  }

  if (confirmDelete) {
    if (ev.type === "char" && (ev.value === "y" || ev.value === "Y")) {
      confirmDelete = false;
      await deleteSelected();
    } else if (ev.type !== "click") {
      confirmDelete = false;
      render();
    }
    continue;
  }

  if (ev.type === "click") {
    const hit = screen.hit(ev.row, ev.col);
    if (!hit) continue;
    if (hit.kind === "row") {
      const index = view().findIndex((m) => m.id === hit.id);
      if (index < 0) continue;
      // First click selects, a second click on the same row inserts.
      if (index === selected) await insert(current(), true);
      else {
        selected = index;
        render();
      }
    } else if (hit.kind === "insert") await insert(current(), true);
    else if (hit.kind === "new") await compose();
    else if (hit.kind === "edit") await editSelected();
    else if (hit.kind === "delete") {
      if (view().length) {
        confirmDelete = true;
        render();
      }
    } else if (hit.kind === "close") break;
    continue;
  }

  if (ev.type === "scroll") {
    move(ev.direction === "up" ? -1 : 1);
    continue;
  }

  if (ev.type === "key") {
    if (ev.value === "up") move(-1);
    else if (ev.value === "down") move(1);
    else if (ev.value === "enter") await insert(current(), true);
    else if (ev.value === "esc") {
      if (!filter) break;
      filter = "";
      selected = 0;
      render();
    }
    continue;
  }

  if (ev.type === "char") {
    if (ev.value >= "1" && ev.value <= "9") {
      await insert(view()[Number(ev.value) - 1], true);
      continue;
    }
    switch (ev.value) {
      case "k": move(-1); break;
      case "j": move(1); break;
      case "K": reorder(-1); break;
      case "J": reorder(1); break;
      case " ":
      case "i": await insert(current(), false); break;
      case "y": copy(current()); break;
      case "p": await openPouchPicker(); break;
      case "I": await openPanePicker(); break;
      case "/": filtering = true; render(); break;
      case "n":
      case "a": await compose(); break;
      case "e": await editSelected(); break;
      case "d":
        if (view().length) {
          confirmDelete = true;
          render();
        }
        break;
      case "g": selected = 0; render(); break;
      case "G": selected = Math.max(0, view().length - 1); render(); break;
      case "q":
      case "\x03":
        screen.leave();
        process.exit(0);
    }
  }
}

screen.leave();
process.exit(0);

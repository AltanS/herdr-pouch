/**
 * Minimal terminal layer: alt screen, raw keys, SGR mouse clicks, and a
 * click-region registry so ASCII art can be made clickable.
 *
 * Styling deliberately sticks to bold/dim/reverse and the 8 ANSI colors so the
 * strip inherits whatever Herdr theme the user runs.
 */

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

export const style = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  reverse: `${CSI}7m`,
  yellow: `${CSI}33m`,
  cyan: `${CSI}36m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
};

export interface Region<T> {
  row: number;
  col: number;
  width: number;
  payload: T;
}

export type Key =
  | { type: "char"; value: string }
  | { type: "key"; value: "up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "backspace" }
  | { type: "click"; row: number; col: number; button: number }
  | { type: "scroll"; direction: "up" | "down" };

export class Screen<T> {
  private regions: Region<T>[] = [];
  private buffer: string[] = [];
  private raw = false;

  get cols() {
    return process.stdout.columns || 80;
  }
  get rows() {
    return process.stdout.rows || 24;
  }

  enter(mouse = true) {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.raw = true;
    }
    process.stdin.resume();
    let seq = `${CSI}?1049h${CSI}?25l`;
    if (mouse) seq += `${CSI}?1000h${CSI}?1006h`;
    process.stdout.write(seq);
    const cleanup = () => this.leave();
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      this.leave();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.leave();
      process.exit(0);
    });
  }

  leave() {
    process.stdout.write(`${CSI}?1006l${CSI}?1000l${CSI}?25h${CSI}?1049l`);
    if (this.raw && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      this.raw = false;
    }
  }

  /** Starts a frame. Regions registered by the previous frame are dropped. */
  begin() {
    this.regions = [];
    this.buffer = [`${CSI}H${CSI}2J`];
  }

  /** Writes `text` at a 0-based cell position. `text` may contain SGR escapes. */
  at(row: number, col: number, text: string) {
    this.buffer.push(`${CSI}${row + 1};${col + 1}H${text}${style.reset}`);
  }

  /** Writes text and registers the cells it covers as clickable. */
  clickable(row: number, col: number, text: string, width: number, payload: T) {
    this.at(row, col, text);
    this.regions.push({ row, col, width, payload });
  }

  end() {
    process.stdout.write(this.buffer.join(""));
    this.buffer = [];
  }

  hit(row: number, col: number): T | null {
    for (const r of this.regions) {
      if (r.row === row && col >= r.col && col < r.col + r.width) return r.payload;
    }
    return null;
  }

  /** Async iterator over decoded input events. */
  async *input(): AsyncGenerator<Key> {
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      yield* decode(chunk.toString("binary"));
    }
  }
}

const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

export function* decode(data: string): Generator<Key> {
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = MOUSE.exec(rest);
    if (mouse) {
      i += mouse[0].length;
      const button = Number(mouse[1]);
      const col = Number(mouse[2]) - 1;
      const row = Number(mouse[3]) - 1;
      const press = mouse[4] === "M";
      if (button === 64) yield { type: "scroll", direction: "up" };
      else if (button === 65) yield { type: "scroll", direction: "down" };
      else if (press && button < 3) yield { type: "click", row, col, button };
      continue;
    }
    if (rest.startsWith(`${CSI}A`)) { yield { type: "key", value: "up" }; i += 3; continue; }
    if (rest.startsWith(`${CSI}B`)) { yield { type: "key", value: "down" }; i += 3; continue; }
    if (rest.startsWith(`${CSI}C`)) { yield { type: "key", value: "right" }; i += 3; continue; }
    if (rest.startsWith(`${CSI}D`)) { yield { type: "key", value: "left" }; i += 3; continue; }

    const ch = data[i]!;
    i += 1;
    if (ch === "\x1b") {
      // A lone ESC, or an escape sequence we don't handle: swallow the rest of
      // the burst so stray bytes never land in the UI as characters.
      if (i >= data.length || data[i] === "\x1b") yield { type: "key", value: "esc" };
      else i = data.length;
      continue;
    }
    if (ch === "\r" || ch === "\n") yield { type: "key", value: "enter" };
    else if (ch === "\t") yield { type: "key", value: "tab" };
    else if (ch === "\x7f" || ch === "\b") yield { type: "key", value: "backspace" };
    // ctrl-c, and the two the built-in editor saves with. Every other control
    // byte stays dropped, so a stray sequence never lands in the text.
    else if (ch === "\x03" || ch === "\x13" || ch === "\x04") yield { type: "char", value: ch };
    else if (ch >= " ") yield { type: "char", value: ch };
  }
}

// --- text helpers ------------------------------------------------------------

/** Collapses a multi-line message to one line for chip/row display. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - text.length));

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Wraps text to `width` columns, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(" ")) {
      if (current && current.length + 1 + word.length > width) {
        out.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
      while (current.length > width) {
        out.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    out.push(current);
  }
  return out;
}

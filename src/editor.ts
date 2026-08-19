/**
 * The text buffer behind Pouch's built-in editor.
 *
 * Kept apart from the drawing so the cursor arithmetic can be reasoned about on
 * its own: every function here is pure text and coordinates, and the caller owns
 * the screen. The editor exists because a message is a paragraph, not a program
 * — and because $EDITOR is whatever the operator's dotfiles say it is, which on
 * a bad day is a modal editor nobody asked for.
 */

export interface Buffer {
  /** Logical lines. A message keeps the newlines the operator typed. */
  lines: string[];
  /** Cursor, in logical coordinates: line index, then character offset. */
  row: number;
  col: number;
}

export function fromText(text: string): Buffer {
  const lines = text.length ? text.split("\n") : [""];
  const row = lines.length - 1;
  return { lines, row, col: lines[row]!.length };
}

export const toText = (buffer: Buffer): string => buffer.lines.join("\n");

const line = (buffer: Buffer): string => buffer.lines[buffer.row] ?? "";

function replaceLine(buffer: Buffer, row: number, text: string) {
  buffer.lines[row] = text;
}

export function insert(buffer: Buffer, text: string) {
  const current = line(buffer);
  replaceLine(buffer, buffer.row, current.slice(0, buffer.col) + text + current.slice(buffer.col));
  buffer.col += text.length;
}

export function newline(buffer: Buffer) {
  const current = line(buffer);
  const before = current.slice(0, buffer.col);
  const after = current.slice(buffer.col);
  buffer.lines.splice(buffer.row, 1, before, after);
  buffer.row += 1;
  buffer.col = 0;
}

export function backspace(buffer: Buffer) {
  if (buffer.col > 0) {
    const current = line(buffer);
    replaceLine(buffer, buffer.row, current.slice(0, buffer.col - 1) + current.slice(buffer.col));
    buffer.col -= 1;
    return;
  }
  if (buffer.row === 0) return;
  // Joining lines: the cursor lands where the two met, not at column 0.
  const previous = buffer.lines[buffer.row - 1]!;
  const current = line(buffer);
  buffer.lines.splice(buffer.row - 1, 2, previous + current);
  buffer.row -= 1;
  buffer.col = previous.length;
}

export type Direction = "left" | "right" | "up" | "down" | "home" | "end";

export function move(buffer: Buffer, direction: Direction) {
  const width = () => (buffer.lines[buffer.row] ?? "").length;
  switch (direction) {
    case "left":
      if (buffer.col > 0) buffer.col -= 1;
      else if (buffer.row > 0) {
        buffer.row -= 1;
        buffer.col = width();
      }
      break;
    case "right":
      if (buffer.col < width()) buffer.col += 1;
      else if (buffer.row < buffer.lines.length - 1) {
        buffer.row += 1;
        buffer.col = 0;
      }
      break;
    case "up":
      if (buffer.row > 0) buffer.row -= 1;
      buffer.col = Math.min(buffer.col, width());
      break;
    case "down":
      if (buffer.row < buffer.lines.length - 1) buffer.row += 1;
      buffer.col = Math.min(buffer.col, width());
      break;
    case "home":
      buffer.col = 0;
      break;
    case "end":
      buffer.col = width();
      break;
  }
}

export interface VisualRow {
  /** Which logical line this row shows part of. */
  line: number;
  /** Offset into that line where the row starts. */
  start: number;
  text: string;
}

export interface Layout {
  rows: VisualRow[];
  /** Cursor position as row index into `rows`, and column within that row. */
  cursorRow: number;
  cursorCol: number;
}

/**
 * Wraps the buffer to `width` columns for display.
 *
 * Hard wrap, not word wrap: the cursor has to map back and forth exactly, and a
 * word-wrapped row would have to remember which space it swallowed.
 */
export function layout(buffer: Buffer, width: number): Layout {
  const cols = Math.max(1, width);
  const rows: VisualRow[] = [];
  let cursorRow = 0;
  let cursorCol = 0;

  buffer.lines.forEach((text, index) => {
    let start = 0;
    do {
      const chunk = text.slice(start, start + cols);
      if (index === buffer.row && buffer.col >= start && buffer.col <= start + cols) {
        // The cursor sits past the end of a full row only when it is at the very
        // end of the line; otherwise it belongs to the next row's column 0.
        const atWrap = buffer.col === start + cols && start + cols < text.length;
        if (!atWrap) {
          cursorRow = rows.length;
          cursorCol = buffer.col - start;
        }
      }
      rows.push({ line: index, start, text: chunk });
      start += cols;
    } while (start < text.length);
  });

  return { rows, cursorRow, cursorCol };
}

/** Moves the cursor to a clicked cell, clamped to the text that is there. */
export function place(buffer: Buffer, rows: VisualRow[], rowIndex: number, col: number) {
  const row = rows[Math.max(0, Math.min(rows.length - 1, rowIndex))];
  if (!row) return;
  buffer.row = row.line;
  buffer.col = Math.min(row.start + Math.max(0, col), (buffer.lines[row.line] ?? "").length);
}

/**
 * ASCII pouches. Every variant is a fixed-width block so layout math stays
 * trivial, and each one carries its own fill: up to four pips, or the count
 * itself once there are more messages than pips.
 *
 * All three sizes draw a handle. That is the point of them: a plain rounded
 * sack collapses into an oval with a dot in it, which the eye reads as a face —
 * the same defect that made the old 👝 indicator look like a mouse. The handle
 * breaks the outline, so the shape survives being small.
 */

const PIP = "▪";
const MAX_PIPS = 4;

function centre(text: string, width: number): string {
  const room = Math.max(0, width - text.length);
  const left = Math.floor(room / 2);
  return " ".repeat(left) + text + " ".repeat(room - left);
}

/**
 * The count as it fits. Pips only while they actually fit the slot — the strip's
 * pouch has two columns, so three messages have to fall back to the numeral or
 * the drawing overruns the chips beside it. `+` is the last resort, for counts
 * too long to write at all.
 */
function fill(count: number, width: number): string {
  if (count === 0) return " ".repeat(width);
  const usePips = count <= MAX_PIPS && count <= width;
  const label = usePips ? PIP.repeat(count) : String(count);
  return centre(label.length <= width ? label : "+", width);
}

export const BIG_WIDTH = 10;

/** 4 rows x 10 cols, for the popup header. */
export const bigPouch = (count: number): string[] => [
  "   ╭──╮   ",
  " ╭─┴──┴─╮ ",
  ` │ ${fill(count, 4)} │ `,
  " ╰──────╯ ",
];

export const SMALL_WIDTH = 6;

/** 3 rows x 6 cols, for the strip. */
export const smallPouch = (count: number): string[] => [
  " ╭──╮ ",
  "╭┴──┴╮",
  `╰─${fill(count, 2)}─╯`,
];

export const TINY_WIDTH = 4;

/** 1 row, for panes too short or too narrow for a block. No room for a handle,
 *  so this one is a badge rather than a drawing. */
export const tinyPouch = (count: number): string => `(${fill(count, 2)})`;

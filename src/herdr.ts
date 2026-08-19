/**
 * Thin wrapper over the `herdr` CLI. Every command we use returns
 * `{"id":..,"result":{..}}` on stdout and a JSON error on stderr with exit 1.
 */

import { run } from "./runtime.ts";

const BIN = process.env.HERDR_BIN_PATH || "herdr";

export class HerdrError extends Error {
  // Declared and assigned separately rather than as constructor parameter
  // properties: those are not erasable syntax, and Node runs this file by
  // stripping types, not compiling them.
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], code: number, stderr: string) {
    super(`herdr ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export async function herdr(...args: string[]): Promise<any> {
  const { stdout, stderr, code } = await run([BIN], args);
  if (code !== 0) throw new HerdrError(args, code, stderr);
  try {
    return JSON.parse(stdout).result;
  } catch {
    return { raw: stdout };
  }
}

/** Same as herdr() but returns null instead of throwing. */
export async function tryHerdr(...args: string[]): Promise<any | null> {
  try {
    return await herdr(...args);
  } catch {
    return null;
  }
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string | null;
  agent_status?: string;
  cwd?: string | null;
  label?: string | null;
  focused: boolean;
  scroll?: { viewport_rows: number } | null;
}

export const getPane = (paneId: string): Promise<PaneInfo | null> =>
  tryHerdr("pane", "get", paneId).then((r) => r?.pane ?? null);

export const listPanes = async (): Promise<PaneInfo[]> =>
  (await tryHerdr("pane", "list"))?.panes ?? [];

export const getWorkspaceLabel = async (workspaceId: string): Promise<string> =>
  (await tryHerdr("workspace", "get", workspaceId))?.workspace?.label ?? workspaceId;

/** Types text into a pane's input WITHOUT submitting it. */
export const sendText = (paneId: string, text: string) =>
  herdr("pane", "send-text", paneId, text);

export const focusPane = (paneId: string) => tryHerdr("agent", "focus", paneId);

export const closePane = (paneId: string) => tryHerdr("pane", "close", paneId);

export const notify = (title: string, body?: string) =>
  tryHerdr("notification", "show", title, ...(body ? ["--body", body] : []));

/**
 * Shows how full a pouch is without spending any screen rows: `title` is what
 * Herdr paints on the pane's top border, and `$pouch` is available to sidebar
 * agent rows. Both are scoped to our own metadata source, so clearing them
 * never disturbs a title or token another source reported.
 */
export async function setPouchIndicator(paneId: string, count: number, format: string) {
  const args = ["pane", "report-metadata", paneId, "--source", "pouch"];
  if (count > 0) {
    const label = format.replaceAll("{count}", String(count));
    args.push("--title", label, "--token", `pouch=${label}`);
  } else {
    args.push("--clear-title", "--clear-token", "pouch");
  }
  await tryHerdr(...args);
}

export interface TabInfo {
  tab_id: string;
  label?: string | null;
  pane_count: number;
}

export const getTab = (tabId: string): Promise<TabInfo | null> =>
  tryHerdr("tab", "get", tabId).then((r) => r?.tab ?? null);

export const listTabs = async (): Promise<TabInfo[]> => (await tryHerdr("tab", "list"))?.tabs ?? [];

export const renameTab = (tabId: string, label: string) => tryHerdr("tab", "rename", tabId, label);

export async function openPluginPane(
  entrypoint: string,
  opts: {
    placement?: string;
    targetPane?: string;
    direction?: "right" | "down";
    width?: string;
    height?: string;
    env?: Record<string, string>;
    focus?: boolean;
    cwd?: string;
  } = {},
): Promise<string | null> {
  const args = ["plugin", "pane", "open", "--plugin", "herdr.pouch", "--entrypoint", entrypoint];
  if (opts.placement) args.push("--placement", opts.placement);
  if (opts.targetPane) args.push("--target-pane", opts.targetPane);
  if (opts.direction) args.push("--direction", opts.direction);
  if (opts.width) args.push("--width", opts.width);
  if (opts.height) args.push("--height", opts.height);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push(opts.focus ? "--focus" : "--no-focus");
  const res = await herdr(...args);
  return res?.plugin_pane?.pane?.pane_id ?? res?.pane?.pane_id ?? null;
}

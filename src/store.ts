/**
 * Pouch storage.
 *
 * A pouch is keyed by (workspace label, cwd, agent) rather than by pane id,
 * because pane ids are never reused: they change when a pane moves and are
 * regenerated on every server restart. Keying by identity means a pouch you
 * filled yesterday is still attached to the same agent this morning.
 *
 * The live pane id is kept as an alias so lookups from a strip pane, an action
 * or the CLI stay a single file read.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  unlinkSync,
  statSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPane, getWorkspaceLabel, listPanes, type PaneInfo } from "./herdr.ts";
import { sleepSync } from "./runtime.ts";

export interface Message {
  id: string;
  text: string;
  createdAt: number;
  usedAt?: number;
  uses: number;
}

export interface Pouch {
  key: string;
  label: string;
  workspace: string;
  cwd: string;
  agent: string;
  messages: Message[];
}

export interface PouchTarget {
  key: string;
  label: string;
  paneId: string | null;
  workspace: string;
  cwd: string;
  agent: string;
}

/**
 * Herdr injects HERDR_PLUGIN_STATE_DIR into plugin panes and actions, but not
 * into a shell where the user runs `herdr-pouch`. The fallback therefore has to
 * reproduce Herdr's own layout exactly, or the CLI and the strip would end up
 * reading two different stores.
 */
export const STATE_DIR =
  process.env.POUCH_STATE_DIR ||
  process.env.HERDR_PLUGIN_STATE_DIR ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "herdr",
    "plugins",
    "herdr.pouch",
  );
const POUCH_DIR = join(STATE_DIR, "pouches");
const ALIAS_FILE = join(STATE_DIR, "aliases.json");
const STRIP_FILE = join(STATE_DIR, "strips.json");
const WORKSPACE_FILE = join(STATE_DIR, "workspaces.json");

const ensureDirs = () => mkdirSync(POUCH_DIR, { recursive: true });

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  ensureDirs();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const pouchPath = (key: string) => join(POUCH_DIR, `${key}.json`);

// --- identity ----------------------------------------------------------------

// NUL joins the parts because it cannot occur in a workspace label, path or
// agent name, so no combination of them can collide. Written as an escape,
// never a raw byte: a literal NUL makes git treat this file as binary.
function deriveKey(workspace: string, cwd: string, agent: string): string {
  return createHash("sha256").update(`${workspace}\0${cwd}\0${agent}`).digest("hex").slice(0, 16);
}

// One `workspace get` per workspace per process: resolving a pouch for every
// live pane otherwise spends a round trip on each of them.
const workspaceLabels = new Map<string, string>();
async function workspaceLabel(workspaceId: string): Promise<string> {
  const cached = workspaceLabels.get(workspaceId);
  if (cached !== undefined) return cached;
  const label = await getWorkspaceLabel(workspaceId);
  workspaceLabels.set(workspaceId, label);
  rememberWorkspace(workspaceId, label);
  return label;
}

// --- workspace renames -------------------------------------------------------
//
// The workspace label is part of the pouch key, so a rename re-keys every pouch
// in that workspace at once. The `workspace_renamed` event carries only the NEW
// label, so the old one has to come from somewhere: we record the label behind
// each workspace id every time we resolve a pane, and that record is what makes
// the migration exact instead of a guess.

const readWorkspaces = (): Record<string, string> => readJson(WORKSPACE_FILE, {});

function rememberWorkspace(workspaceId: string, label: string) {
  const known = readWorkspaces();
  if (known[workspaceId] === label) return;
  known[workspaceId] = label;
  writeJson(WORKSPACE_FILE, known);
}

/**
 * Moves every pouch in a renamed workspace onto its new key. Returns the number
 * migrated. Without this the pouches survive on disk but nothing maps to them:
 * their panes now hash to a different key and show an empty pouch.
 */
export function rekeyWorkspace(workspaceId: string, newLabel: string): number {
  const previous = readWorkspaces()[workspaceId];
  rememberWorkspace(workspaceId, newLabel);
  workspaceLabels.set(workspaceId, newLabel);
  if (!previous || previous === newLabel) return 0;

  let moved = 0;
  for (const pouch of allPouches()) {
    if (pouch.workspace !== previous) continue;
    const key = deriveKey(newLabel, pouch.cwd, pouch.agent);
    if (key === pouch.key) continue;
    const from = pouch.key;
    // Merge rather than overwrite: a pouch may already exist under the new name
    // if the workspace was renamed back and forth.
    mutate(
      key,
      (target) => {
        const seen = new Set(target.messages.map((m) => m.id));
        for (const msg of pouch.messages) if (!seen.has(msg.id)) target.messages.push(msg);
      },
      { key, label: `${newLabel}/${pouch.agent}`, paneId: null, workspace: newLabel, cwd: pouch.cwd, agent: pouch.agent },
    );
    mutate(from, (old) => {
      old.messages = [];
    });
    repointAliases(from, key);
    moved += 1;
  }
  return moved;
}

async function targetFromPane(pane: PaneInfo): Promise<PouchTarget> {
  const workspace = await workspaceLabel(pane.workspace_id);
  const cwd = pane.cwd ?? "";
  const agent = pane.agent ?? pane.label ?? "shell";
  const key = deriveKey(workspace, cwd, agent);
  adoptProvisional(pane, workspace, cwd, key);
  const target: PouchTarget = { key, label: `${workspace}/${agent}`, paneId: pane.pane_id, workspace, cwd, agent };
  setAlias(pane.pane_id, key);
  return target;
}

/**
 * Herdr reports no agent for a pane until it has detected one, so `agent` falls
 * back to the pane label and then to "shell". A message stashed inside that
 * window lands under a provisional key the settled pane would never look at
 * again — so as soon as the real name arrives (the `pane_agent_detected` hook
 * runs this), fold the provisional pouches into the real one.
 */
function adoptProvisional(pane: PaneInfo, workspace: string, cwd: string, key: string) {
  if (!pane.agent) return; // Still settling: the fallback key *is* today's identity.
  const provisional = [pane.label, "shell"].filter((name): name is string => Boolean(name) && name !== pane.agent);
  for (const name of provisional) {
    const from = deriveKey(workspace, cwd, name);
    if (from === key) continue;
    const source = loadPouch(from);
    if (!source?.messages.length) continue;
    const init: PouchTarget = {
      key,
      label: `${workspace}/${pane.agent}`,
      paneId: pane.pane_id,
      workspace,
      cwd,
      agent: pane.agent,
    };
    // Two locks, taken one after the other rather than nested: a crash between
    // them duplicates a message, which the id check then swallows on the retry.
    mutate(
      key,
      (pouch) => {
        const seen = new Set(pouch.messages.map((m) => m.id));
        for (const msg of source.messages) if (!seen.has(msg.id)) pouch.messages.push(msg);
      },
      init,
    );
    mutate(from, (pouch) => {
      pouch.messages = []; // savePouch unlinks an emptied pouch.
    });
    repointAliases(from, key);
  }
}

/**
 * Resolves a pane id to its pouch. Falls back to the stored alias when the pane
 * is gone, so a strip can still show what it holds while its agent restarts.
 */
export async function resolveTarget(paneId: string): Promise<PouchTarget> {
  const pane = await getPane(paneId);
  if (pane) return targetFromPane(pane);

  const key = getAlias(paneId);
  if (key) {
    const pouch = loadPouch(key);
    if (pouch) return targetFromPouch(pouch);
  }
  throw new Error(`no pane ${paneId} and no pouch remembered for it`);
}

/** Resolves a user-supplied target: a pane id, a live agent name, or "here". */
export async function resolveSelector(selector: string | undefined): Promise<PouchTarget> {
  const sel = selector ?? "here";
  if (sel === "here") {
    const paneId = process.env.POUCH_TARGET_PANE || process.env.HERDR_PANE_ID;
    if (!paneId) throw new Error("not inside a herdr pane — pass --pane <id> or --agent <name>");
    return resolveTarget(paneId);
  }
  // Herdr ids are base36-ish, not decimal: w1T:p17, w37:pC.
  if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(sel)) return resolveTarget(sel);

  const panes = await listPanes();
  const match = panes.filter((p) => p.agent === sel || p.label === sel);
  if (match.length === 1) return targetFromPane(match[0]!);
  if (match.length > 1) {
    throw new Error(`"${sel}" matches ${match.length} panes (${match.map((p) => p.pane_id).join(", ")})`);
  }
  const pouch = findPouchByLabel(sel);
  if (pouch) return targetFromPouch(pouch);
  throw new Error(`no pane, agent or pouch named "${sel}"`);
}

// --- aliases -----------------------------------------------------------------

const readAliases = (): Record<string, string> => readJson(ALIAS_FILE, {});

export function setAlias(paneId: string, key: string) {
  const aliases = readAliases();
  if (aliases[paneId] === key) return;
  aliases[paneId] = key;
  writeJson(ALIAS_FILE, aliases);
}

export const getAlias = (paneId: string): string | undefined => readAliases()[paneId];

export function aliasForKey(key: string): string | null {
  for (const [paneId, k] of Object.entries(readAliases())) if (k === key) return paneId;
  return null;
}

/** Moves every alias pointing at `from` onto `to`, after a pouch is folded in. */
function repointAliases(from: string, to: string) {
  const aliases = readAliases();
  let changed = false;
  for (const [paneId, key] of Object.entries(aliases)) {
    if (key !== from) continue;
    aliases[paneId] = to;
    changed = true;
  }
  if (changed) writeJson(ALIAS_FILE, aliases);
}

// --- live panes --------------------------------------------------------------

/**
 * Every open pane indexed by the pouch identity it resolves to. This is how a
 * saved pouch finds its pane again: an alias records the pane id a pouch was
 * last seen on, but pane ids die with the pane, so a pouch whose agent has been
 * restarted only matches by identity.
 */
export async function livePanesByKey(): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const pane of await listPanes()) {
    const workspace = await workspaceLabel(pane.workspace_id);
    const key = deriveKey(workspace, pane.cwd ?? "", pane.agent ?? pane.label ?? "shell");
    if (!byKey.has(key)) byKey.set(key, pane.pane_id);
  }
  return byKey;
}

/**
 * A saved pouch as a target. `paneId` is filled in only when a pane is actually
 * alive for it — handing back a remembered-but-dead id is what made a closed
 * agent's pouch look inserted-into and silently swallow the text.
 */
export async function targetFromPouch(pouch: Pouch, live?: Map<string, string>): Promise<PouchTarget> {
  const base = {
    key: pouch.key,
    label: pouch.label,
    workspace: pouch.workspace,
    cwd: pouch.cwd,
    agent: pouch.agent,
  };
  const known = live ?? null;
  if (known) return { ...base, paneId: known.get(pouch.key) ?? null };

  const alias = aliasForKey(pouch.key);
  if (alias && (await getPane(alias))) return { ...base, paneId: alias };
  return { ...base, paneId: (await livePanesByKey()).get(pouch.key) ?? null };
}

// --- pouches -----------------------------------------------------------------

export function loadPouch(key: string): Pouch | null {
  const p = pouchPath(key);
  if (!existsSync(p)) return null;
  return readJson<Pouch | null>(p, null);
}

export function loadOrInit(target: PouchTarget): Pouch {
  return (
    loadPouch(target.key) ?? {
      key: target.key,
      label: target.label,
      workspace: target.workspace,
      cwd: target.cwd,
      agent: target.agent,
      messages: [],
    }
  );
}

export function savePouch(pouch: Pouch) {
  if (pouch.messages.length === 0) {
    // An empty pouch is indistinguishable from no pouch; don't leave litter.
    try {
      unlinkSync(pouchPath(pouch.key));
    } catch {}
    return;
  }
  writeJson(pouchPath(pouch.key), pouch);
}

export function allPouches(): Pouch[] {
  ensureDirs();
  return readdirSync(POUCH_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Pouch | null>(join(POUCH_DIR, f), null))
    .filter((p): p is Pouch => p !== null);
}

const findPouchByLabel = (label: string): Pouch | null =>
  allPouches().find((p) => p.label === label || p.agent === label) ?? null;

export const pouchMtime = (key: string): number => {
  try {
    return statSync(pouchPath(key)).mtimeMs;
  } catch {
    return 0;
  }
};

// --- message operations ------------------------------------------------------
//
// The strip, the popup, the CLI and the event hooks are separate processes that
// all mutate the same file, and some hold a pouch across an await (an $EDITOR
// session, a `pane send-text` round trip). Every mutation therefore runs under
// a lock and re-reads inside it, so a caller's stale copy can never overwrite
// someone else's concurrent write.

let counter = 0;
const newId = () => `${Date.now().toString(36).slice(-5)}${(counter++).toString(36)}`;

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;

function acquire(key: string): string {
  ensureDirs();
  const lock = `${pouchPath(key)}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return lock;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue; // The holder released it between our mkdir and stat.
      }
      if (Date.now() > deadline) {
        // Better to risk an interleaving than to wedge the UI on a stuck lock.
        return lock;
      }
      sleepSync(15);
    }
  }
}

/** Runs `fn` against the freshest pouch on disk, under an exclusive lock. */
function mutate<T>(key: string, fn: (pouch: Pouch) => T, init?: PouchTarget): T {
  const lock = acquire(key);
  try {
    const pouch = loadPouch(key) ?? (init ? loadOrInit(init) : null);
    if (!pouch) throw new Error(`pouch ${key} no longer exists`);
    const result = fn(pouch);
    savePouch(pouch);
    return result;
  } finally {
    try {
      rmdirSync(lock);
    } catch {}
  }
}

export function addMessage(target: PouchTarget, text: string, front = false): Message {
  const msg: Message = { id: newId(), text: text.replace(/\s+$/, ""), createdAt: Date.now(), uses: 0 };
  return mutate(
    target.key,
    (pouch) => {
      if (front) pouch.messages.unshift(msg);
      else pouch.messages.push(msg);
      return msg;
    },
    target,
  );
}

/** Resolves a message by id, by 1-based slot number, or by unique text prefix. */
export function findMessage(pouch: Pouch, ref: string): Message | null {
  const slot = Number(ref);
  if (Number.isInteger(slot) && slot >= 1 && slot <= pouch.messages.length) return pouch.messages[slot - 1]!;
  const byId = pouch.messages.find((m) => m.id === ref);
  if (byId) return byId;
  const hits = pouch.messages.filter((m) => m.text.toLowerCase().startsWith(ref.toLowerCase()));
  return hits.length === 1 ? hits[0]! : null;
}

export const removeMessage = (key: string, id: string): boolean =>
  mutate(key, (pouch) => {
    const before = pouch.messages.length;
    pouch.messages = pouch.messages.filter((m) => m.id !== id);
    return pouch.messages.length !== before;
  });

export const updateMessage = (key: string, id: string, text: string): boolean =>
  mutate(key, (pouch) => {
    const msg = pouch.messages.find((m) => m.id === id);
    if (!msg) return false;
    msg.text = text.replace(/\s+$/, "");
    return true;
  });

export const moveMessage = (key: string, id: string, delta: number): boolean =>
  mutate(key, (pouch) => {
    const from = pouch.messages.findIndex((m) => m.id === id);
    if (from < 0) return false;
    const to = Math.min(pouch.messages.length - 1, Math.max(0, from + delta));
    if (to === from) return false;
    const [msg] = pouch.messages.splice(from, 1);
    pouch.messages.splice(to, 0, msg!);
    return true;
  });

export const markUsed = (key: string, id: string, consume: boolean): void =>
  mutate(key, (pouch) => {
    const msg = pouch.messages.find((m) => m.id === id);
    if (!msg) return;
    msg.uses += 1;
    msg.usedAt = Date.now();
    if (consume) pouch.messages = pouch.messages.filter((m) => m.id !== id);
  });

export const clearMessages = (key: string): void =>
  mutate(key, (pouch) => {
    pouch.messages = [];
  });

// --- tab mark bookkeeping ----------------------------------------------------
// Remembering the exact mark we appended is what lets us take it off again
// after the indicator has been reconfigured; deriving the pattern from the
// current config would orphan marks written under the old one.

const MARK_FILE = join(STATE_DIR, "tabmarks.json");

export const readTabMarks = (): Record<string, string> => readJson(MARK_FILE, {});

/** Forgets marks for tabs that no longer exist — they can never be stripped. */
export function pruneTabMarks(liveTabIds: string[]) {
  const live = new Set(liveTabIds);
  const marks = readTabMarks();
  const stale = Object.keys(marks).filter((tabId) => !live.has(tabId));
  if (!stale.length) return 0;
  for (const tabId of stale) delete marks[tabId];
  writeJson(MARK_FILE, marks);
  return stale.length;
}

export function setTabMark(tabId: string, mark: string | null) {
  const marks = readTabMarks();
  if (mark === null) delete marks[tabId];
  else marks[tabId] = mark;
  writeJson(MARK_FILE, marks);
}

// --- strip bookkeeping -------------------------------------------------------

export const readStrips = (): Record<string, string> => readJson(STRIP_FILE, {});

export function setStrip(targetPaneId: string, stripPaneId: string | null) {
  const strips = readStrips();
  if (stripPaneId === null) delete strips[targetPaneId];
  else strips[targetPaneId] = stripPaneId;
  writeJson(STRIP_FILE, strips);
}

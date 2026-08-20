#!/usr/bin/env bun
/**
 * `herdr-pouch` — prepare messages for an agent before it needs them.
 *
 * Runs from any shell inside Herdr (targets the calling pane by default), from
 * another agent (`--pane w1:p3`), or from a plugin action.
 */

import { style, oneLine, truncate, ago } from "./tui.ts";
import {
  resolveSelector,
  resolveTarget,
  loadPouch,
  addMessage,
  removeMessage,
  findMessage,
  clearMessages,
  allPouches,
  livePanesByKey,
  rekeyWorkspace,
  pruneTabMarks,
  markUsed,
  type PouchTarget,
} from "./store.ts";
import { loadConfig, BIN } from "./config.ts";
import { readStdin, sleep } from "./runtime.ts";
import { tryHerdr, sendText, listPanes, listTabs } from "./herdr.ts";
import { openStrip, closeStrip, openPopup, syncIndicator, insertFirst, SUBMIT_SETTLE_MS } from "./ops.ts";
import { setup, KEYBINDS } from "./setup.ts";
import { update, wantsMajor } from "./update.ts";

const USAGE = `${BIN} — stash messages for a Herdr agent and insert them later

usage:
  ${BIN} add [target] [text...]     stash a message (reads stdin when no text)
  ${BIN} list [target] [--all]      show a pouch, or every pouch with --all
  ${BIN} show <ref> [target]        print one message in full
  ${BIN} insert [ref] [target]      type it into the agent's input
                                         (no ref = top; --submit presses enter;
                                          --to <pane> aims it elsewhere)
  ${BIN} rm <ref> [target]          remove a message
  ${BIN} clear [target]             empty the pouch
  ${BIN} strip [target]             pin the pouch strip under the pane [--height N]
  ${BIN} unstrip [target]           remove the strip
  ${BIN} open [target]              open the pouch popup
  ${BIN} browse                     open the picker over every saved pouch
  ${BIN} sync                       repaint the pouch indicators
  ${BIN} setup [--no-keys]         link the plugin, install this CLI, add the keys
  ${BIN} update [--major]          pull the newest release and re-link the plugin
  ${BIN} key [target]               print the resolved pouch identity

target:
  --here            the calling pane (default)
  --pane w1:p3      an explicit pane id
  --agent name      a live agent name, or a saved pouch label

refs are 1-based slot numbers, message ids, or a unique text prefix.`;

const argv = process.argv.slice(2);
const cmd = argv.shift() ?? "help";

interface Flags {
  pane?: string;
  agent?: string;
  to?: string;
  all: boolean;
  submit: boolean;
  front: boolean;
  height?: string;
  rest: string[];
}

function parse(args: string[]): Flags {
  const flags: Flags = { all: false, submit: false, front: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pane") flags.pane = args[++i];
    else if (a === "--to") flags.to = args[++i];
    else if (a === "--agent") flags.agent = args[++i];
    else if (a === "--height") flags.height = args[++i];
    else if (a === "--here") flags.pane = "here";
    else if (a === "--all") flags.all = true;
    else if (a === "--submit") flags.submit = true;
    else if (a === "--front" || a === "--top") flags.front = true;
    else if (a === "--") flags.rest.push(...args.slice(i + 1)), (i = args.length);
    else flags.rest.push(a);
  }
  return flags;
}

const flags = parse(argv);
const selector = flags.pane ?? flags.agent;

const target = async (): Promise<PouchTarget> => resolveSelector(selector);

function die(msg: string): never {
  console.error(`${BIN}: ${msg}`);
  process.exit(1);
}

async function requireMessage(t: PouchTarget, ref: string) {
  const pouch = loadPouch(t.key) ?? die(`pouch for ${t.label} is empty`);
  const msg = findMessage(pouch, ref) ?? die(`no message matching "${ref}" in ${t.label}`);
  return { pouch, msg };
}

/**
 * Every pane, tab and workspace id named anywhere in the triggering event.
 *
 * Matches on the SUFFIX, not the exact key: `pane_moved` reports the tab a pane
 * came from as `previous_tab_id` / `closed_tab_id`, and that old tab is the one
 * that just lost a member and may now need a tab-label mark. Matching `tab_id`
 * exactly would see only the destination and leave the origin stale.
 */
function eventScope(): { panes: string[]; tabs: string[]; workspaces: string[] } | null {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return null;
  try {
    const panes = new Set<string>();
    const tabs = new Set<string>();
    const workspaces = new Set<string>();
    JSON.stringify(JSON.parse(raw), (key, value) => {
      if (typeof value === "string") {
        if (key.endsWith("pane_id")) panes.add(value);
        else if (key.endsWith("tab_id")) tabs.add(value);
        else if (key.endsWith("workspace_id")) workspaces.add(value);
      }
      return value;
    });
    const scope = { panes: [...panes], tabs: [...tabs], workspaces: [...workspaces] };
    return scope.panes.length || scope.tabs.length || scope.workspaces.length ? scope : null;
  } catch {
    return null;
  }
}

/** The event kind that triggered this run, when there is one. */
function eventKind(): string | null {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}").event ?? null;
  } catch {
    return null;
  }
}

/**
 * A workspace rename re-keys every pouch in it. Without this the pouches are
 * still on disk but nothing maps to them — and the repaint that follows would
 * resolve every pane to the new, empty key and strip the indicator off panes
 * that do still hold messages, erasing the last clue that anything was there.
 */
function rekeyRenamedWorkspace() {
  if (eventKind() !== "workspace_renamed") return;
  try {
    const data = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON!).data ?? {};
    if (typeof data.workspace_id !== "string" || typeof data.label !== "string") return;
    const moved = rekeyWorkspace(data.workspace_id, data.label);
    if (moved) console.log(`re-keyed ${moved} pouch(es) onto workspace "${data.label}"`);
  } catch {}
}

/**
 * Which panes an event obliges us to repaint.
 *
 * Never just the pane the event names. The tab-label mark depends on how many
 * panes share the tab, so a pane arriving or leaving changes the answer for
 * every *sibling* — and `pane_closed` carries no tab_id and names a pane that
 * is already gone, so the only way to reach that tab's survivors is to sweep
 * the workspace the event does name.
 */
async function panesToSync(): Promise<string[]> {
  const all = await listPanes();
  const scope = eventScope();
  if (!scope) return all.map((p) => p.pane_id);

  const named = new Set(scope.panes);
  const tabs = new Set(scope.tabs);
  for (const pane of all) if (named.has(pane.pane_id)) tabs.add(pane.tab_id);
  // A named pane that no longer exists means something closed: fall back to its
  // workspace, since its tab cannot be resolved any more.
  const gone = scope.panes.some((id) => !all.some((p) => p.pane_id === id));
  const workspaces = new Set(gone ? scope.workspaces : []);

  const targets = all.filter(
    (p) => named.has(p.pane_id) || tabs.has(p.tab_id) || workspaces.has(p.workspace_id),
  );
  return targets.map((p) => p.pane_id);
}

// --- commands ----------------------------------------------------------------

switch (cmd) {
  case "add": {
    const t = await target();
    const text = flags.rest.join(" ").trim() || (await readStdin());
    if (!text) die("nothing to stash — pass text or pipe it in");
    const msg = addMessage(t, text, flags.front);
    const count = loadPouch(t.key)!.messages.length;
    await syncIndicator(t);
    console.log(
      `${style.green}＋${style.reset} stashed in ${style.bold}${t.label}${style.reset} ` +
        `(slot ${count}, id ${msg.id})  pouch://${t.paneId ?? t.key}`,
    );
    break;
  }

  case "list":
  case "ls": {
    if (flags.all) {
      const pouches = allPouches();
      if (!pouches.length) console.log(`${style.dim}no pouches yet${style.reset}`);
      const live = await livePanesByKey();
      for (const p of pouches) {
        const pane = live.get(p.key) ?? `${style.yellow}no live pane${style.reset}${style.dim}`;
        console.log(`${style.bold}${p.label}${style.reset} ${style.dim}${pane} · ${p.key} · ${p.cwd}${style.reset}`);
        p.messages.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}  ${truncate(oneLine(m.text), 70)}`));
      }
      break;
    }
    const t = await target();
    const pouch = loadPouch(t.key);
    console.log(`${style.bold}${t.label}${style.reset} ${style.dim}${t.paneId ?? "(pane gone)"} · ${t.key}${style.reset}`);
    if (!pouch?.messages.length) {
      console.log(`${style.dim}  (empty)${style.reset}`);
      break;
    }
    pouch.messages.forEach((m, i) => {
      const used = m.uses ? `${style.dim} ·${m.uses}×${style.reset}` : "";
      console.log(`  ${String(i + 1).padStart(2)}  ${truncate(oneLine(m.text), 68)} ${style.dim}${ago(m.createdAt)}${style.reset}${used}`);
    });
    break;
  }

  case "show": {
    const ref = flags.rest[0] ?? die("show needs a ref");
    const t = await target();
    const { msg } = await requireMessage(t, ref);
    console.log(msg.text);
    break;
  }

  case "insert": {
    const t = await target();
    const ref = flags.rest[0];
    if (!ref) {
      // No ref means "the next one" — the same path the global insert bindings take.
      const outcome = await insertFirst(t, { submit: flags.submit, to: flags.to });
      if ("reason" in outcome) die(outcome.reason);
      console.log(`${style.green}→${style.reset} inserted into ${flags.to ?? t.paneId}`);
      break;
    }
    const to = flags.to ?? t.paneId;
    if (!to) die(`${t.label} has no live pane to insert into — pass --to <pane>`);
    const { pouch, msg } = await requireMessage(t, ref);
    await sendText(to, msg.text);
    if (flags.submit) {
      await sleep(SUBMIT_SETTLE_MS);
      await tryHerdr("pane", "send-keys", to, "enter");
    }
    markUsed(pouch.key, msg.id, loadConfig().consumeOnInsert);
    await syncIndicator(t);
    console.log(`${style.green}→${style.reset} inserted into ${to}`);
    break;
  }

  case "rm":
  case "remove": {
    const ref = flags.rest[0] ?? die("rm needs a ref");
    const t = await target();
    const { pouch, msg } = await requireMessage(t, ref);
    removeMessage(pouch.key, msg.id);
    await syncIndicator(t);
    console.log(`${style.red}✕${style.reset} removed ${msg.id}`);
    break;
  }

  case "clear": {
    const t = await target();
    if (loadPouch(t.key)) clearMessages(t.key);
    await syncIndicator(t);
    console.log(`emptied ${t.label}`);
    break;
  }

  case "strip": {
    const t = await target();
    if (!t.paneId) die(`${t.label} has no live pane`);
    const stripPane = await openStrip(t.paneId, flags.height ? Number(flags.height) : undefined);
    console.log(`pinned pouch strip ${stripPane} under ${t.paneId}`);
    break;
  }

  case "unstrip": {
    const t = await target();
    if (!t.paneId) die(`${t.label} has no live pane`);
    console.log(`removed strip ${await closeStrip(t.paneId)}`);
    break;
  }

  case "open": {
    const clicked = process.env.HERDR_PLUGIN_CLICKED_URL?.replace(/^pouch:\/\//, "");
    await openPopup(clicked ? await resolveSelector(clicked) : await target());
    break;
  }

  case "browse": {
    await openPopup(null, "browse");
    break;
  }

  case "sync": {
    // Called from the event hooks and from [[startup]]. Narrow to what the
    // event touched; a bare `sync` with no event sweeps everything.
    rekeyRenamedWorkspace();
    const paneIds = await panesToSync();
    // Only on a full sweep: an event names a slice of the session, which says
    // nothing about whether the tabs it didn't mention still exist.
    if (!eventScope()) pruneTabMarks((await listTabs()).map((t) => t.tab_id));
    for (const paneId of paneIds) {
      try {
        await syncIndicator(await resolveTarget(paneId));
      } catch {}
    }
    break;
  }

  case "setup": {
    const steps = await setup({ keys: !argv.includes("--no-keys") });
    for (const step of steps) {
      const mark = step.ok ? `${style.green}✓${style.reset}` : `${style.yellow}!${style.reset}`;
      console.log(`${mark} ${style.bold}${step.what.padEnd(6)}${style.reset} ${step.detail}`);
    }
    console.log(`\n${style.dim}keys:${style.reset} ${KEYBINDS.map((b) => `${b.key} → ${b.description}`).join("  ·  ")}`);
    console.log(`${style.dim}next:${style.reset} stash something — \`${BIN} add "run the tests"\` — then press prefix+shift+O.`);
    if (steps.some((s) => !s.ok)) process.exit(1);
    break;
  }

  case "update": {
    const steps = await update({ major: wantsMajor(argv) });
    for (const step of steps) {
      const mark = step.ok ? `${style.green}✓${style.reset}` : `${style.yellow}!${style.reset}`;
      console.log(`${mark} ${style.bold}${step.what.padEnd(8)}${style.reset} ${step.detail}`);
    }
    if (steps.some((s) => !s.ok)) process.exit(1);
    break;
  }

  case "key": {
    const t = await target();
    console.log(JSON.stringify(t, null, 2));
    break;
  }

  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;

  default:
    console.error(`${BIN}: unknown command "${cmd}"\n`);
    console.error(USAGE);
    process.exit(2);
}

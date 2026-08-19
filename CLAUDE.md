# CLAUDE.md — working agreement for this repo

**Pouch** (repo `AltanS/herdr-pouch`) — a [Herdr](https://herdr.dev) plugin for stashing prompts
before an agent needs them and inserting them when it is ready. Plugin id `herdr.pouch`
(manifest: `herdr-plugin.toml`). Bun + TypeScript, no build step. Orientation:
[`README.md`](./README.md).

## Versioning — MANDATORY

Pouch is **SemVer**ed, and the version is **enforced**, so it never silently drifts.

**The version lives in two files that must always agree, plus a matching CHANGELOG entry:**
`herdr-plugin.toml` (canonical — Herdr reads it) · `package.json` · newest `## [x.y.z]` heading in
`CHANGELOG.md`.

**Before committing any functional change** (anything under `src/`, `scripts/`, `bin/`, or the
manifest) you MUST:

1. **Bump** the version in both files to the same number. The axis is **what the operator has to
   do**, not how visible the change is:
   - **PATCH** (`0.2.0 → 0.2.1`): the code now does what it was always meant to do — bug fixes and
     internal refactors. A fix may well change what you see; that alone never promotes it.
   - **MINOR** (`0.2.0 → 0.3.0`): something is there that wasn't — a new command, action, key, or
     config option. Existing setups keep working untouched.
   - **MAJOR** (`0.2.0 → 1.0.0`): the operator must change something — a config key or CLI flag
     renamed or removed, a stored-format break, a workflow that used to work and now doesn't.
2. **Add a `CHANGELOG.md` entry** under a new `## [x.y.z] - YYYY-MM-DD` heading (Added / Changed /
   Fixed). Use the real date. **Style: crisp and short** — one line per change, no prose paragraphs.
3. **Run `scripts/check-version.sh`** — it must print `✓`.

Doc-only changes (`*.md`) don't need a bump.

**Tag the release when you push it.** `git tag -a vX.Y.Z -m "Pouch X.Y.Z" && git push --follow-tags`
so the tag ships *with* the release. One `v<x.y.z>` tag per shipped version on the remote.

## Build / run

- **No build step.** Plugin panes run `scripts/run.sh <entrypoint>`, which picks a runtime and
  executes `src/<entrypoint>.ts` directly. Herdr launches plugin commands with a minimal
  environment — never assume anything is on `PATH` there; the shim checks the usual install
  locations too.
- **Both runtimes are supported and both must keep working.** Bun is preferred when present,
  Node ≥ 22.6 otherwise. Two rules keep that true:
  **(1)** every runtime difference goes in `src/runtime.ts` — no `Bun.*` or Node-only global may
  appear anywhere else in `src/`; **(2)** `erasableSyntaxOnly` is on, because Node *strips* types
  rather than compiling them — no enums, namespaces, or constructor parameter properties.
  Check both after touching either: `POUCH_RUNTIME=node ./bin/herdr-pouch list` and
  `POUCH_RUNTIME=bun …`.
- **Don't ship a compiled binary.** `bun build --compile` staples the entire Bun runtime onto the
  bundle: 91 MB of executable for 28 KB of code, per platform. Running the source is smaller and
  needs no release pipeline.
- **Typecheck is the gate:** `bun x tsc --noEmit`. Strict, with `noUnusedLocals/Parameters` and
  `noUncheckedIndexedAccess`. There is no test suite yet; verify against a live Herdr session
  instead (see below).
- **`herdr plugin link "$PWD"` must be re-run after any manifest change** — Herdr caches the
  action/pane/hook set at link time.
- **Actions run detached.** Their stdout only reaches `herdr plugin log list --plugin herdr.pouch`;
  anything the operator must see goes through `notify()`. `herdr plugin action invoke doctor` dumps
  the resolved paths and invocation context there.

## Verifying UI work without eyes on the screen

Herdr renders pane chrome (borders, tab bar, sidebar) in its **client**, so it cannot be read back
over the API. Split the difference:

- **Plugin pane content** is readable — open the entrypoint as a `split` instead of a `popup` and
  `herdr pane read <id> --source visible` it. Popup panes do not appear in `pane list` at all.
- **Input can be injected**: `herdr pane send-text <pane> "$(printf '\033[<0;COL;ROWM')"` delivers a
  real SGR mouse click, and plain text delivers keystrokes. This is how the click and key paths are
  exercised.
- **Chrome needs the operator.** Ask what they see rather than asserting it rendered.

## Herdr API gotchas (learned the hard way — don't relearn them)

- **Pane ids are base36-ish, not decimal** — `w1T:p17`, `w37:pC`. Anything matching a pane id must
  allow letters.
- **Borders only exist around split panes.** A pane alone in its tab has no chrome, so a metadata
  `title` paints nowhere; `syncIndicator()` falls back to the tab label and hands back on split.
- **`plugin pane open` rejects `--width`/`--height` unless placement is `popup`**, and a fresh split
  lands at 50/50. `openStrip()` shrinks afterwards with `pane resize`, converging (Herdr's floor is
  ~4 rows).
- **One popup per session.** A second `open` fails with `popup already open`.
- **`pane send-text` types without submitting** — that is the whole point of the insert path. When
  submitting deliberately, wait `SUBMIT_SETTLE_MS` before the Enter: agent input widgets ingest a
  bracketed paste asynchronously and an immediate Enter submits an empty line.
- **Herdr binds one chord after the prefix.** `prefix+p+o` and other sequences are rejected outright
  by the parser. Validate any binding with `herdr config check` against a *copy* of the config before
  writing the real one.
- **Pane metadata does not survive a server restart** — hence the `[[startup]]` hook.
- **Manifest event names are dotted; the payload spells them snake_case.** `on = "pane.agent_detected"`
  in `[[events]]`, but `HERDR_PLUGIN_EVENT_JSON` comes back as `{"event":"pane_agent_detected"}`.
  Writing the payload spelling parses fine and *never fires* — it only surfaces as an
  `unknown event` warning in `herdr plugin link` output. **Read those warnings.** Accepted (0.8.0):
  `pane.{created,closed,focused,moved,exited,agent_detected,agent_status_changed}`,
  `tab.{created,closed,renamed,focused,moved}`, `workspace.{created,closed,focused,renamed}`.
- **`pane_closed` carries `pane_id` + `workspace_id` and no `tab_id`**, and the pane is already gone
  by the time the hook runs — so the tab that just lost a pane can only be reached by sweeping the
  workspace. `pane_created` does carry the whole pane object.
- **`pane_moved` names the tab a pane came from as `previous_tab_id` / `closed_tab_id`.** Match ids
  by suffix, not by exact key, or you repaint the destination tab and leave the origin stale.
- **`renameTab()` echoes back as a `tab.renamed` event we are subscribed to.** That is intentional
  and convergent — the repaint it triggers finds the label already correct and `syncIndicator`'s
  `wanted !== label` guard writes nothing, so it settles after one extra spawn. Don't "fix" it by
  filtering self-originated renames. Note it also lands on Herdr's shared event bus, so another
  plugin watching `tab.renamed` for operator intent will see ours too; there is no quiet-rename flag.
- **Tearing down a workspace re-sweeps it once per `pane.closed`.** The events carry no tab id and
  name an already-dead pane, so each close falls back to sweeping the workspace: closing n panes
  costs O(n²) API round trips. Fine at a handful of panes, deliberately not debounced — add
  coalescing before adding any more sweep-fallback hooks.
- **The `pouch=` metadata token does not render in the sidebar**, and a lone pane has no border to
  paint a `--title` on. On a single-pane tab the tab label is the *only* indicator that shows, which
  is why `syncIndicator()` writes it and why the events above have to keep it honest.

## Storage rules

- `STATE_DIR` and the config dir **must mirror what Herdr injects** (`HERDR_PLUGIN_STATE_DIR` /
  `HERDR_PLUGIN_CONFIG_DIR`). The fallbacks in `store.ts` / `config.ts` reproduce Herdr's own layout
  exactly, because the CLI runs in a plain shell where those variables are absent — if the fallback
  drifts, the strip and the CLI silently read two different stores.
- **Every pouch mutation goes through `mutate()`** in `store.ts`: it takes a lock and re-reads inside
  it. Callers hold pouches across awaits (an `$EDITOR` session, a `send-text` round trip), so a
  caller's stale copy must never be written back wholesale.
- **A pouch is keyed by identity, not by pane id** — `(workspace label, cwd, agent)`. Pane ids are
  never reused and change on move and on server restart. Don't "simplify" this to the pane id.
- **A pane reports no agent until Herdr detects one**, so the key falls back to the pane label and
  then `shell`. `adoptProvisional()` folds those pouches into the real one once the name lands —
  without it, anything stashed in that window is stranded under a key nothing looks at again.
- **A pouch outlives its pane, so every surface must cope with `paneId === null`.** Never hand out a
  remembered pane id without checking it is alive (`targetFromPouch`), and never make reaching a
  pouch depend on its agent still running — the picker is the only way back into an orphan.
- **An empty pouch is deleted, not stored** — no litter in the state dir.

## Conventions

- Comments explain **why**, at the line that would otherwise be changed by mistake. Don't narrate
  what the code already says.
- The TUI sticks to bold/dim/reverse and the 8 ANSI colors so it inherits the operator's Herdr theme.
  Don't hardcode a palette.
- User-facing errors name the remedy (`"a popup is already open — close it with esc first"`), not
  the internal failure.

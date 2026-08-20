# Changelog

All notable changes to Pouch are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml` and `package.json` (enforced by `scripts/check-version.sh`).
See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [0.3.1] - 2026-08-20

### Fixed

- `update` and `setup` no longer crash when `git` or `herdr` is missing from the environment they
  run in. A spawn failure is an error event, not an exit code, so it aborted the step report with a
  stack trace instead of naming the remedy.
- `herdr` is now located the way `scripts/run.sh` locates Bun — PATH first, then the usual install
  locations. A plain `ssh host 'herdr-pouch update'` gets a shell whose PATH never sourced a
  profile, so a bare `herdr` was not found there.

## [0.3.0] - 2026-08-20

### Added

- **`update` action and `herdr-pouch update`** — advance the checkout and re-register it with Herdr
  in one step. Herdr has no `plugin update`, and a forgotten `herdr plugin link` leaves it on the
  action set it cached at link time.
- Handles both checkout shapes: a linked clone fast-forwards its branch, a Herdr-managed checkout
  re-detaches onto the newest release tag. A managed checkout is never re-linked — that would make
  Herdr refuse `plugin install`, the only other way to repair it.
- **`update-major` action and `update --major`** — a routine update stays inside the major it is on.
  Crossing one is a separate, deliberate invocation, because a major means the operator must change
  something.

## [0.2.0] - 2026-08-20

### Added

- `doctor` now reports keybinding health: which chord holds each action, and a named remedy when a
  key is bound but dead. The warning is the notification, not a line in the log.
- `doctor` detects an attached remote client, which is the one case where every Pouch key stops
  working while Herdr's own chords keep going.

### Changed

- `setup` now writes `type = "plugin_action"` bindings instead of `type = "shell"`. Herdr invokes
  the action directly, so a key no longer depends on `herdr` being on `PATH`.
- `setup` rewrites its own older block in place, so a re-run migrates `shell` bindings without
  touching a chord you bound yourself. Bindings you hand-placed outside that block are reported,
  never rewritten.

## [0.1.0] - 2026-08-19

First release.

### Added

- **Pouch** — stash messages for a Herdr agent before it needs them, then insert them one keypress
  at a time. Text is typed into the agent's input, never submitted.
- **`herdr-pouch setup`** — one command finishes the install: links the plugin, installs the CLI,
  adds the default keybindings to `config.toml`, and reloads the server. Idempotent, skips a chord
  you already use, and only writes after `herdr config check` accepts a copy.
- **The popup** (`prefix+shift+O`) — browse, filter, reorder, copy, insert; `p` switches pouch and
  `I` re-aims where inserts go.
- **A built-in editor** — `n` and `e` open a plain text box: `ctrl-s` saves, `esc` cancels, `enter`
  starts a new line, and a click places the cursor. The `editor` config key points elsewhere:
  `"system"` for `$VISUAL`/`$EDITOR`, or any command such as `"nano -I"` or `"micro"`.
- **Indicators** — a 👜 on the pane border, or on the tab label when the pane is alone in its tab.
  Event hooks keep it honest across splits, moves, closes and renames.
- **The CLI** — `add`, `list`, `show`, `insert`, `rm`, `clear`, `strip`, `open`, `browse`, `sync`,
  `key`. Stash from a shell, a script, or one agent preparing work for another.
- **The strip** (optional) — a three-row pouch pinned under an agent pane, clickable.
- **Actions and a `pouch://` link handler**, so a stashed message is one click from where it landed.
- Runs on Bun or Node 22.6+, straight from the TypeScript source. No build step, no binary.

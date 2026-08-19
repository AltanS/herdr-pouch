# Changelog

All notable changes to Pouch are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml` and `package.json` (enforced by `scripts/check-version.sh`).
See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

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

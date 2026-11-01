# Worktree include

New git worktrees come ready to run. Add a `.worktreeinclude` to a repo,
listing gitignored files like `.env`, `.npmrc` or `config/local.json`, and
open a space on the repo. From then on, every new worktree of that repo gets
those files copied in from the main checkout, whether you make it with
Herdr's New worktree, Claude Code or `git worktree add`, and whether Herdr is
open or not. A small floating window shows each repo, whether it's switched
on, and what each worktree got. Nothing is ever overwritten.

![Worktree include](preview.png)

## What you see

- **A floating window**, 320×260px, opened with `cmd-alt-i`. It's a Herdr
  window overlay: drag it anywhere, it remembers its spot and reopens on the
  next start until closed. Background is the theme's `chrome`, with Herdr's
  own window border and shadow.
- **Title bar**, 36px, a 1px `border` line below it: "Worktree include"
  (13px semibold, `foreground`) on the left. On the right: `.worktreeinclude`
  (11px, `dim`) and a 20×20 "×" close button (`dim`, `raised` background and
  `foreground` on hover).
- **A scrolling list** with 6px padding and 10px between repos. The repo of
  the space you're looking at comes first. For each repo:
  - **Repo header**, 24px, 11px type: the main checkout's folder name in
    uppercase, semibold, `muted` (`ACME-API`), then its path with home as `~`
    (`dim`, truncated; `machine:path` for a remote repo). On the right is
    a **hook pill**, 18px high, fully rounded, 10px type, 1px border:
    - `● hook on` in `done` color (border too);
    - `○ hook off` in `muted`, `border`;
    - `own hook` or `hooksPath` in `dim`;
    - `hook failed` in `blocked`;
    - a braille spinner while it checks.
  - **A note line** (11px, `dim`) under the header when the hook can't be
    used, saying why and that this window copies instead while it's open.
  - "No worktrees open" (11px, `dim`) when only the main checkout is open.
  - **One 28px row per worktree space** (6px corners, 10px side padding):
    a fold triangle `▸`/`▾` (`dim`), the branch name (truncated; `foreground`
    for the shown space, else `muted`), a status (12px), and a Copy button
    (11px, `muted`, 1px `border`, 4px corners, 20px high).
  - **Unfolded**, under the row (28px left indent, 11px, `dim`): the
    worktree's path, then each copied file as `+ .env.local` (`muted`, first
    30, then "… N more"), "N already there, left alone", "No .worktreeinclude
    in <main>", or the first line of an error in `blocked`.
- **Empty**: "No repo with a .worktreeinclude open." (12px, `muted`), then
  "Add a .worktreeinclude to a repo (gitignore syntax: .env,
  config/local.json) and open a space on it. New worktrees of it then get
  those files." (`dim`).

## How it behaves

- **Switching a repo on**: the first time the window sees a space on a repo
  (its main checkout or any worktree) that has a `.worktreeinclude`, it
  installs a git `post-checkout` hook there. A success toast says "Worktree
  include is on for acme-api", and the pill reads `● hook on`.
- **A new worktree**: `git worktree add` runs the hook, which copies the
  files before the command returns. In a terminal, git prints
  `worktreeinclude: copied 3 file(s) from <main>`. When a space opens on it,
  its row appears (spinner, 90ms frames, `working` color), then `+3` in
  `done` color, with a toast: "Copied 3 files into feature/billing" and the
  first four names. The count includes what the hook copied, read from a
  record the hook leaves in the worktree's git folder.
- **What gets copied**: untracked files in the main checkout that match a
  pattern in `<main>/.worktreeinclude` (gitignore syntax) **and** are ignored
  by git. Tracked files arrive with the checkout anyway; ignored files the
  list doesn't name (`node_modules/`, `*.log`) stay put. A bare pattern
  like `.env` matches at any depth (`.devcontainer/.env` too); `/.env`
  means only the top-level one.
- **Never overwrites**: a file or link already in the worktree is skipped
  and counted under "already there, left alone".
- **Where the hook can't go**, the window copies instead, but only while
  it's open, and its note line says so:
  - the repo already has its own `post-checkout` hook (`own hook`), or
  - `core.hooksPath` is set, as husky and lefthook do (`hooksPath`).
  A new worktree space gets its files within about a second of appearing.
- **Each worktree is handled once.** Delete a copied file and it stays
  deleted. After a restart or reload, handled worktrees show `6 ✓` (how many
  files match, `muted`), or `nothing` when none match.
- **Statuses**: spinner (looking or copying), `+N` (copied), `N ✓` (all
  there), `nothing`, `no list` (`dim`: no `.worktreeinclude`), `N files:
  click` (`blocked`: over 2000 matches, not copied without a click), `failed`
  (`blocked`; unfold for the error).
- **Clicks**:
  - `● hook on` removes the hook (toast "Worktree include is off for …") and
    remembers not to put it back. `○ hook off` installs it again.
  - A row selects its space (`space.select`). The triangle unfolds and folds
    without selecting.
  - **Copy** copies whatever is missing now, including past 2000, and shows
    what that click copied.
  - Presses on rows and controls don't drag the window; anywhere else drags.
- **Keys**: `cmd-alt-i` opens the window. `cmd-alt-shift-i` copies into the
  shown space's worktree, the same as its Copy button. In a space that isn't
  a linked worktree it shows a "Not a worktree" toast. That key works only
  while the window is open.

## Built from

- `mods/worktreeinclude/main.js`: one `View`, no assets.
- `mods/worktreeinclude/mod.json`: `{ "place": "none", "title": "Worktree
  include", "overlay": { "kind": "window", "width": 320, "height": 260,
  "key": "worktreeinclude", "keep": true } }`. `mod.open` opens it as a kept
  window, which works on any layout, Herdr's shipped ones included.
- `keys.json` (merge into the person's `global`):
  `"cmd-alt-i": "mod.open:worktreeinclude"`,
  `"cmd-alt-shift-i": "worktreeinclude.copy"`.
- `herdr` functions: `spaces()`, `panes()` (a space's place is its first
  terminal's `cwd`, else `space.folder`), `exec` (`git` and `sh`, with
  `on: space.machine`), `readTextFile` (the hook's record), `notify`,
  `focused`, `nextCommand` (`"copy"`), `home`, `props().overlay` /
  `closeOverlay`, `run("space.select", {id})`, `theme()`, `localStorage`
  (`"done"`: handled worktrees; `"off"`: repos whose hook was removed; last
  500 each).
- **Finding repos and worktrees**: `cx.timer.every(1000)` walks `spaces()` in
  plain JS. Only a place it hasn't seen before (`[machine, path]`) costs git
  calls: `git rev-parse --show-toplevel` and `git rev-parse
  --path-format=absolute --git-common-dir`. A common dir ending in `/.git`
  names the repo (its parent is the main checkout). A top that differs from
  the main checkout is a linked worktree. Branch comes from `git branch
  --show-current`.
- **The hook check**, once per repo:
  1. `[ -f "$main/.worktreeinclude" ]`, `git config --get core.hooksPath`.
  2. The hook's path: `git rev-parse --path-format=absolute --git-path
     hooks/post-checkout`; read it with `cat`.
  3. If it contains `herdr-worktreeinclude` it's ours: on, and rewritten if
     its `vN` is older. Otherwise hooksPath set means `managed`, and any other
     content means `other`. Missing, with a list and the repo not in `"off"`:
     write it with `printf "%s" "$2" > "$1" && chmod +x "$1"` (via `sh`, so
     it works on remote machines too).
  4. Removing it: `grep -q herdr-worktreeinclude "$1" && rm "$1"`.
- **The hook** (`#!/bin/sh`, marker line `# herdr-worktreeinclude v1`):
  1. Exits unless the previous HEAD (`$1`) is all zeros (a fresh checkout),
     unless it's in a linked worktree (common dir ends `/.git`, its parent
     isn't the top), and unless the main checkout has a `.worktreeinclude`.
  2. `unset $(git rev-parse --local-env-vars)` (git sets `GIT_DIR` for
     hooks), then `cd` into the main checkout.
  3. Lists files, pipes them through `xargs -0` into the copy loop, and
     writes what it copied to `$(git rev-parse --absolute-git-dir)/
     worktreeinclude-copied` (inside the worktree's own git folder, so it
     goes when the worktree does).
  4. Prints the count to stderr. Always `exit 0`.
- **Listing** (main checkout): `git ls-files -z --others --ignored
  --exclude-from=.worktreeinclude | git check-ignore -z --stdin`.
- **Copy loop**, shared by the hook and the window, given `src dst file…`:
  skip if `[ -e ]` or `[ -L ]` in `dst`, else `mkdir -p` the folder,
  `cp -p`, and print the name. The window runs it 200 files per call.

## Watch out

- **It writes into repos.** It adds `.git/hooks/post-checkout` to every repo
  with a `.worktreeinclude` that it sees, with a toast, and never replaces a
  hook it didn't write. Tell the person before adding the mod. The pill
  removes the hook.
- Git runs `post-checkout` in the new worktree with `GIT_DIR` set. Without
  `unset $(git rev-parse --local-env-vars)`, git commands after `cd` still
  read the worktree, not the main checkout.
- A `post-checkout` hook's exit status becomes git's, so the hook must always
  `exit 0` or a failed copy would fail `git worktree add`.
- The hook's copy loop is the window's `COPY` script inside `sh -c '…'`, so
  single quotes in it must be escaped as `'"'"'`. Check with `sh -n`.
- Repos with the hook don't need the window at all. Repos without it (own
  hook, `core.hooksPath`) only get files while the window is open. The window
  closes with ×, and a layout switch closes it until that layout shows again.
- The window isn't docked: Herdr's shipped layouts don't take new blocks, so
  a `"place": "right"` build never shows and never runs.
- `stop_propagation` is on `cx`, not the event. Clickable parts also need
  `.on_mouse_down("left", (_e, cx) => cx.stop_propagation())`, or pressing
  them drags the window.
- The toast's `icon` must be a real icon name or it draws a blank square;
  this build sends none.
- The list used is the **main checkout's** `.worktreeinclude`. Changing it
  doesn't touch worktrees made before; press Copy. A repo is checked once per
  run: a `.worktreeinclude` added while the window is open is noticed after
  the next start (or a mod reload).
- Needs a POSIX `sh`, `xargs -0` and git 2.31 or newer
  (`--path-format=absolute`). On Windows the local machine runs
  `C:/Program Files/Git/bin/sh.exe` (Git for Windows), since `sh` isn't on
  `PATH`; without it a repo shows `failed`.
  Bare repos are skipped. `git worktree add --no-checkout` doesn't run the
  hook; the window catches those while it's open.
- Copies can include secrets. They go only between checkouts on the same
  machine.

## Done when

- `herdr-app check mods/worktreeinclude` passes. `cmd-alt-i` opens the window
  with the empty message when no repo with a `.worktreeinclude` is open.
- Make a repo whose `.gitignore` has `.env`, `.env.local`, `config/local.json`,
  `node_modules/` and `*.log`, all present in the main checkout, and whose
  `.worktreeinclude` lists the first three. Open a space on it: within a few
  seconds `.git/hooks/post-checkout` exists, is executable, starts with
  `# herdr-worktreeinclude v1`, and passes `sh -n`. A toast says "Worktree
  include is on for <repo>", and the pill reads `● hook on`.
- With Herdr's window closed, `git worktree add -b feature/billing
  ../wt/feature-billing` in a terminal prints `worktreeinclude: copied 3
  file(s) from …` and exits 0. The worktree then has `.env`, `.env.local` and
  `config/local.json`, and no `node_modules` or `debug.log`.
- Opening a space on that worktree shows `feature/billing +3`.
- `git checkout -b x && git checkout main` in the main checkout copies
  nothing and prints nothing.
- A worktree that already has its own `.env` keeps it unchanged.
- Delete `.env.local` from a worktree, select its space and press
  `cmd-alt-shift-i`. It comes back, and the row reads `+1`.
- In a repo with its own `post-checkout` hook, the hook is untouched, the
  pill reads `own hook` with its note, and a new worktree space still gets
  its files from the window.

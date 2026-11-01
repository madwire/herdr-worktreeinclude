// Worktree include: new git worktrees get the gitignored files their repo
// lists in .worktreeinclude (gitignore syntax, in the main checkout).
//
// For each repo with a .worktreeinclude it installs a small git post-checkout
// hook, so `git worktree add` copies the files itself, with Herdr open or not
// and before the new space or its agent starts. Where it can't (the repo has
// its own post-checkout hook, or core.hooksPath manages hooks) this window
// copies instead, while it's open. Nothing is ever overwritten.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, exec, run, theme, notify, focused, nextCommand, home, props, closeOverlay, readTextFile, window } from "herdr";

const FILE = ".worktreeinclude";
const MARK = "herdr-worktreeinclude";
const VERSION = 1;
const LOG = "worktreeinclude-copied"; // in a worktree's own git dir: what the hook copied
const TOO_MANY = 2000; // more matches than this: don't copy on its own, ask for a click
const CHUNK = 200; // files per cp batch (argument length)

// The copy loop, shared by the hook and this window: src dst file...
// Skips anything already there (file or link), prints what it copied.
const COPY = `src=$1; dst=$2; shift 2
for f do
  if [ -e "$dst/$f" ] || [ -L "$dst/$f" ]; then continue; fi
  mkdir -p "$dst/$(dirname "$f")" && cp -p "$src/$f" "$dst/$f" && printf '%s\\n' "$f"
done`;

// Untracked files in the main checkout that match .worktreeinclude AND are
// ignored by git (tracked files come with the checkout anyway).
const LIST = `git ls-files -z --others --ignored --exclude-from=${FILE} | git check-ignore -z --stdin`;

const HOOK = `#!/bin/sh
# ${MARK} v${VERSION}
# Copies the gitignored files listed in the main checkout's ${FILE} into
# each new worktree (git worktree add). Never overwrites a file.
# Installed by the Herdr mod "Worktree include"; delete this file to turn it off.

# Only a fresh checkout: the previous HEAD is all zeros.
case "$1" in *[!0]*) exit 0 ;; esac
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
[ "$(basename "$common")" = .git ] || exit 0
main=$(dirname "$common")
[ "$main" = "$top" ] && exit 0
[ -f "$main/${FILE}" ] || exit 0
# Git sets GIT_DIR and friends for hooks; the listing runs in the main checkout.
unset $(git rev-parse --local-env-vars)
cd "$main" || exit 0
${LIST} |
  xargs -0 sh -c '${COPY.replace(/'/g, `'"'"'`)}' sh "$main" "$top" > "$gitdir/${LOG}" 2>/dev/null
n=$(wc -l < "$gitdir/${LOG}" | tr -d ' ')
[ "$n" -gt 0 ] 2>/dev/null && echo "worktreeinclude: copied $n file(s) from $main" >&2
exit 0
`;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}
const key = (on, path) => JSON.stringify([on ?? null, path]);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();
const lines = (s) => (s ?? "").split("\n").filter(Boolean);

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
// Windows has no sh on PATH: on this machine use the one Git for Windows ships.
const shell = (on) => (!on && window()?.platform === "windows" ? "C:/Program Files/Git/bin/sh.exe" : "sh");
const sh = (script, args, on) => exec(shell(on), ["-c", script, "sh", ...args], { on });

function loadSet(name) {
  try { return new Set(JSON.parse(localStorage.getItem(name) ?? "[]")); } catch { return new Set(); }
}

export default class WorktreeInclude extends View {
  init(_props, cx) {
    this.places = new Map(); // key(on, place) -> { repo, tree } (tree null for the main checkout), or null outside git
    this.repos = new Map(); // key(on, main) -> { on, main, include, hook, hookPath, note }
    this.trees = new Map(); // key(on, top) -> { on, top, repo, main, branch, state, copied, skipped, matched, error }
    this.open = new Set(); // trees whose file list is unfolded
    this.done = loadSet("done"); // worktrees handled once already
    this.off = loadSet("off"); // repos whose hook the person removed
    try { this.userHome = home().replace(/\\/g, "/"); } catch { this.userHome = ""; }
    cx.timer.every(1000, (cx) => this.look(cx));
    this.look(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "copy") this.copyFocused(cx);
        cx.notify();
      }
    });
  }

  save(name) {
    try { localStorage.setItem(name, JSON.stringify([...this[name]].slice(-500))); } catch {}
  }

  // Cheap: only places not seen before cost git calls.
  look(cx) {
    const fresh = [];
    for (const s of spaces()) {
      const p = place(s);
      if (!p) continue;
      const k = key(s.machine, p);
      if (!this.places.has(k)) { this.places.set(k, undefined); fresh.push([s.machine ?? null, p, k]); }
    }
    if (!fresh.length) return;
    cx.spawn(async (cx) => {
      for (const [on, p, k] of fresh) {
        try {
          const top = await git(p, ["rev-parse", "--show-toplevel"], on);
          const common = await git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
          if (!top.ok || !common.ok || !common.out.endsWith("/.git")) { this.places.set(k, null); continue; }
          const main = common.out.slice(0, -5);
          const rk = key(on, main);
          if (!this.repos.has(rk)) {
            this.repos.set(rk, { on, main, include: null, hook: "busy", note: null });
            await this.checkRepo(rk, cx);
          }
          if (main === top.out) { this.places.set(k, { repo: rk, tree: null }); continue; }
          const tk = key(on, top.out);
          this.places.set(k, { repo: rk, tree: tk });
          if (!this.trees.has(tk)) {
            const branch = await git(top.out, ["branch", "--show-current"], on);
            this.trees.set(tk, { on, top: top.out, repo: rk, main, branch: branch.out || base(top.out), state: "new", copied: [], skipped: 0, matched: 0 });
            cx.notify();
            await this.arrive(tk, cx);
          }
        } catch {
          this.places.delete(k); // machine away: ask again next look
        }
      }
      cx.notify();
    });
  }

  // ---- The hook ----

  // Is there a .worktreeinclude, and what about the hook: install it when it
  // should be there, update an older one of ours, leave anyone else's alone.
  async checkRepo(rk, cx) {
    const r = this.repos.get(rk);
    r.hook = "busy";
    r.note = null;
    cx.notify();
    try {
      r.include = (await sh(`[ -f "$1/${FILE}" ]`, [r.main], r.on)).code === 0;
      const hooksPath = await git(r.main, ["config", "--get", "core.hooksPath"], r.on);
      const path = await git(r.main, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/post-checkout"], r.on);
      r.hookPath = path.out;
      const now = (await sh('cat "$1" 2>/dev/null', [r.hookPath], r.on)).stdout ?? "";
      if (now.includes(MARK)) {
        r.hook = "on";
        if (!now.includes(`${MARK} v${VERSION}`)) await this.writeHook(r); // ours, older: update
      } else if (hooksPath.ok && hooksPath.out) {
        r.hook = "managed";
        r.note = `Hooks are managed by core.hooksPath (${hooksPath.out}): new worktrees get their files from this window, while it's open.`;
      } else if (now.trim()) {
        r.hook = "other";
        r.note = "This repo has its own post-checkout hook: new worktrees get their files from this window, while it's open.";
      } else if (r.include && !this.off.has(rk)) {
        await this.writeHook(r);
        r.hook = "on";
        notify({ title: `Worktree include is on for ${base(r.main)}`, body: `New worktrees get the files in its ${FILE}, with Herdr open or not.`, level: "success" });
      } else {
        r.hook = "off";
      }
    } catch (e) {
      r.hook = "error";
      r.note = String(e?.message ?? e);
    }
    cx.notify();
  }

  async writeHook(r) {
    const w = await sh('mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod +x "$1"', [r.hookPath, HOOK], r.on);
    if (w.code !== 0) throw new Error((w.stderr ?? "").trim() || "Couldn't write the hook.");
  }

  // The hook pill: on -> remove it (and remember not to put it back), off -> install.
  toggleHook(rk, cx) {
    const r = this.repos.get(rk);
    if (!r || (r.hook !== "on" && r.hook !== "off")) return;
    cx.spawn(async (cx) => {
      try {
        if (r.hook === "on") {
          const rm = await sh(`grep -q '${MARK}' "$1" && rm "$1"`, [r.hookPath], r.on);
          if (rm.code !== 0) throw new Error("Couldn't remove the hook.");
          this.off.add(rk);
          this.save("off");
          r.hook = "off";
          notify({ title: `Worktree include is off for ${base(r.main)}`, body: "New worktrees get their files only while this window is open.", level: "info" });
        } else {
          this.off.delete(rk);
          this.save("off");
          await this.checkRepo(rk, cx);
        }
      } catch (e) {
        r.note = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // ---- Copying ----

  async list(t) {
    const has = await sh(`[ -f "$1/${FILE}" ]`, [t.main], t.on);
    if (has.code !== 0) return null;
    const r = await sh(`cd "$1" && ${LIST}`, [t.main], t.on);
    return (r.stdout ?? "").split("\0").filter(Boolean);
  }

  // A worktree seen for the first time: what the hook copied, then (the first
  // time only) anything still missing; later runs only count.
  async arrive(tk, cx) {
    const t = this.trees.get(tk);
    try {
      const gd = await git(t.top, ["rev-parse", "--absolute-git-dir"], t.on);
      t.byHook = gd.ok ? lines(await readTextFile(`${gd.out}/${LOG}`, { on: t.on })) : [];
    } catch { t.byHook = []; }
    if (!this.done.has(tk)) await this.copy(tk, true, cx);
    else await this.count(tk, cx);
  }

  async count(tk, cx) {
    const t = this.trees.get(tk);
    try {
      const files = await this.list(t);
      if (files === null) { t.state = "nofile"; return; }
      t.matched = files.length;
      t.copied = t.byHook ?? [];
      t.state = "done";
    } catch (e) { t.state = "error"; t.error = String(e?.message ?? e); }
    cx.notify();
  }

  async copy(tk, auto, cx) {
    const t = this.trees.get(tk);
    if (!t || t.state === "copying") return;
    t.state = "copying";
    t.error = null;
    cx.notify();
    try {
      const files = await this.list(t);
      if (files === null) { t.state = "nofile"; this.remember(tk); return; }
      t.matched = files.length;
      if (auto && files.length > TOO_MANY) { t.state = "toomany"; return; }
      const mine = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        const r = await sh(COPY, [t.main, t.top, ...files.slice(i, i + CHUNK)], t.on);
        mine.push(...lines(r.stdout));
        if (r.code !== 0 && r.stderr) t.error = r.stderr.trim().split("\n")[0];
      }
      // On arrival, what the hook copied counts too; a click shows only that click.
      const copied = auto ? [...new Set([...(t.byHook ?? []), ...mine])] : mine;
      t.copied = copied;
      t.skipped = files.length - copied.length;
      t.state = t.error ? "error" : "done";
      this.remember(tk);
      if (copied.length) {
        notify({ title: `Copied ${copied.length} file${copied.length === 1 ? "" : "s"} into ${t.branch}`, body: copied.slice(0, 4).join(", ") + (copied.length > 4 ? ", …" : ""), level: "success" });
      }
    } catch (e) {
      t.state = "error";
      t.error = String(e?.message ?? e);
    }
    cx.notify();
  }

  remember(tk) {
    this.done.add(tk);
    this.save("done");
  }

  copyFocused(cx) {
    const f = focused();
    const s = spaces().find((x) => x.id === f?.space);
    const tk = s && this.places.get(key(s.machine, place(s)))?.tree;
    if (tk) cx.spawn(async (cx) => { await this.copy(tk, false, cx); });
    else notify({ title: "Not a worktree", body: "This space isn't a linked git worktree.", level: "info" });
  }

  tilde(p) {
    return this.userHome && p.startsWith(this.userHome) ? `~${p.slice(this.userHome.length)}` : p;
  }

  // ---- UI ----

  render(cx) {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation(); // presses on controls don't drag the window
    const spinner = () => div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);

    // Repos with a space open now, and their worktree spaces.
    const shown = new Map(); // repo key -> [[tree key, space]]
    for (const s of spaces()) {
      const p = place(s);
      const at = p && this.places.get(key(s.machine, p));
      if (!at || !this.repos.has(at.repo)) continue;
      if (!shown.has(at.repo)) shown.set(at.repo, []);
      if (at.tree && this.trees.has(at.tree) && !shown.get(at.repo).some(([tk]) => tk === at.tree)) shown.get(at.repo).push([at.tree, s]);
    }
    // A repo without a .worktreeinclude only shows when a worktree of it is open.
    // The shown space's repo comes first.
    const active = spaces().find((s) => s.active);
    const here = active && this.places.get(key(active.machine, place(active)))?.repo;
    const repos = [...shown].filter(([rk, rows]) => this.repos.get(rk).include || rows.length)
      .sort(([a], [b]) => (b === here) - (a === here));

    const status = (tr) => {
      switch (tr.state) {
        case "new":
        case "copying": return spinner().text_color(t.working);
        case "nofile": return div().text_color(t.dim).child("no list");
        case "toomany": return div().text_color(t.blocked).child(`${tr.matched} files: click`);
        case "error": return div().text_color(t.blocked).child("failed");
        default:
          return tr.copied.length
            ? div().text_color(t.done).child(`+${tr.copied.length}`)
            : div().text_color(t.muted).child(tr.matched ? `${tr.matched} ✓` : "nothing");
      }
    };

    const pill = (rk, r) => {
      const el = h_flex().id(`h-${rk}`).h(18).px(6).gap(4).rounded(9).items_center().text_size(10).border(1);
      switch (r.hook) {
        case "busy": return el.border_color(t.border).child(spinner().text_color(t.working));
        case "on":
          return el.border_color(t.done).text_color(t.done).cursor_pointer()
            .hover((s) => s.bg(t.raised)).on_mouse_down("left", stop)
            .on_click((_e, cx) => this.toggleHook(rk, cx)).child("●").child("hook on");
        case "off":
          return el.border_color(t.border).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", stop)
            .on_click((_e, cx) => this.toggleHook(rk, cx)).child("○").child("hook off");
        case "other": return el.border_color(t.border).text_color(t.dim).child("own hook");
        case "managed": return el.border_color(t.border).text_color(t.dim).child("hooksPath");
        default: return el.border_color(t.blocked).text_color(t.blocked).child("hook failed");
      }
    };

    const row = ([tk, s]) => {
      const tr = this.trees.get(tk);
      const unfolded = this.open.has(tk);
      return v_flex()
        .child(
          h_flex().id(`w-${tk}`).h(28).px(10).gap(8).items_center().rounded(6)
            .when(s.active, (el) => el.bg(t.selected))
            .hover((el) => el.bg(t.hover))
            .on_mouse_down("left", stop)
            .on_click(() => run("space.select", { id: s.id }))
            .child(div().id(`f-${tk}`).w(10).text_color(t.dim).child(unfolded ? "▾" : "▸")
              .on_click((_e, cx) => { cx.stop_propagation(); unfolded ? this.open.delete(tk) : this.open.add(tk); cx.notify(); }))
            .child(div().flex_1().truncate().text_color(s.active ? t.foreground : t.muted).child(tr.branch))
            .child(status(tr).text_size(12))
            .child(
              div().id(`c-${tk}`).px(6).h(20).rounded(4).flex().items_center().text_size(11)
                .text_color(t.muted).border(1).border_color(t.border)
                .hover((el) => el.bg(t.raised).text_color(t.foreground))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => { await this.copy(tk, false, cx); }); })
                .child("Copy")))
        .when(unfolded, (el) => el.child(
          v_flex().pl(28).pr(10).pb(6).gap(2).text_size(11).text_color(t.dim)
            .child(div().truncate().child(this.tilde(tr.top)))
            .when(tr.state === "nofile", (el) => el.child(div().child(`No ${FILE} in ${this.tilde(tr.main)}`)))
            .when(!!tr.error, (el) => el.child(div().text_color(t.blocked).child(tr.error)))
            .children(tr.copied.slice(0, 30).map((f) => div().truncate().text_color(t.muted).child(`+ ${f}`)))
            .when(tr.copied.length > 30, (el) => el.child(div().child(`… ${tr.copied.length - 30} more`)))
            .when(tr.skipped > 0, (el) => el.child(div().child(`${tr.skipped} already there, left alone`)))));
    };

    return v_flex().id("root").size_full().bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(
        h_flex().h(36).px(12).items_center().justify_between().border_b(1).border_color(t.border)
          .child(div().font_semibold().child("Worktree include"))
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(11).text_color(t.dim).child(FILE))
            .when(!!props()?.overlay, (el) => el.child(
              div().id("close").w(20).h(20).rounded(4).flex().items_center().justify_center().text_color(t.dim)
                .hover((el) => el.bg(t.raised).text_color(t.foreground))
                .on_mouse_down("left", stop)
                .on_click(() => closeOverlay(props().overlay))
                .child("×")))))
      .child(
        v_flex().flex_1().id("list").overflow_y_scrollbar().p(6).gap(10)
          .when(repos.length === 0, (el) => el.child(
            v_flex().p(8).gap(6).text_size(12).text_color(t.muted)
              .child(div().child("No repo with a .worktreeinclude open."))
              .child(div().text_color(t.dim).child(`Add a ${FILE} to a repo (gitignore syntax: .env, config/local.json) and open a space on it. New worktrees of it then get those files.`))))
          .children(repos.map(([rk, rows]) => {
            const r = this.repos.get(rk);
            return v_flex().gap(2)
              .child(h_flex().px(10).h(24).gap(6).items_center().text_size(11).text_color(t.dim)
                .child(div().font_semibold().text_color(t.muted).child(base(r.main).toUpperCase()))
                .child(div().flex_1().truncate().child(r.on ? `${r.on}:${this.tilde(r.main)}` : this.tilde(r.main)))
                .when(r.include, (el) => el.child(pill(rk, r))))
              .when(!!r.note, (el) => el.child(div().px(10).pb(2).text_size(11).text_color(r.hook === "error" ? t.blocked : t.dim).child(r.note)))
              .when(rows.length === 0, (el) => el.child(div().px(10).h(22).text_size(11).text_color(t.dim).child("No worktrees open")))
              .children(rows.map(row));
          })));
  }
}

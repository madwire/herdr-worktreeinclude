// Worktree include: copies the gitignored files a repo lists in its
// .worktreeinclude (gitignore syntax, in the main checkout) into every new
// linked worktree that shows up as a space. Never overwrites a file.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, exec, run, theme, notify, focused, nextCommand, home, props, closeOverlay } from "herdr";

const FILE = ".worktreeinclude";
const TOO_MANY = 2000; // more matches than this: don't copy on its own, ask for a click
const CHUNK = 200; // files per cp batch (argument length)

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}
const key = (on, path) => JSON.stringify([on ?? null, path]);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// Untracked files in the main checkout that match .worktreeinclude AND are
// ignored by git (tracked files come with the checkout anyway).
const LIST = 'cd "$1" && git ls-files -z --others --ignored --exclude-from=' + FILE + " | git check-ignore -z --stdin";
// Copies each missing file, printing the ones it copied. Existing files (or links) are left alone.
const COPY = `src=$1; dst=$2; shift 2
for f do
  if [ -e "$dst/$f" ] || [ -L "$dst/$f" ]; then continue; fi
  mkdir -p "$dst/$(dirname "$f")" && cp -p "$src/$f" "$dst/$f" && printf '%s\\n' "$f"
done`;

export default class WorktreeInclude extends View {
  init(_props, cx) {
    this.places = new Map(); // key(on, place) -> tree key, or null (not a linked worktree)
    this.trees = new Map(); // key(on, top) -> { on, top, main, branch, state, copied, skipped, matched, error }
    this.open = new Set(); // trees whose file list is unfolded
    try { this.done = new Set(JSON.parse(localStorage.getItem("done") ?? "[]")); } catch { this.done = new Set(); }
    try { this.userHome = home(); } catch { this.userHome = ""; }
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

  // Cheap: only places not seen before cost a git call.
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
          if (main === top.out) { this.places.set(k, null); continue; } // the main checkout itself
          const tk = key(on, top.out);
          this.places.set(k, tk);
          if (!this.trees.has(tk)) {
            const branch = await git(top.out, ["branch", "--show-current"], on);
            this.trees.set(tk, { on, top: top.out, main, branch: branch.out || base(top.out), state: "new", copied: [], skipped: 0, matched: 0 });
            cx.notify();
            if (!this.done.has(tk)) await this.copy(tk, true, cx);
            else await this.count(tk, cx);
          }
        } catch {
          this.places.delete(k); // machine away: ask again next look
        }
      }
      cx.notify();
    });
  }

  async list(t) {
    const has = await exec("sh", ["-c", `[ -f "$1/${FILE}" ]`, "sh", t.main], { on: t.on });
    if (has.code !== 0) return null;
    const r = await exec("sh", ["-c", LIST, "sh", t.main], { on: t.on });
    return (r.stdout ?? "").split("\0").filter(Boolean);
  }

  // How many matches are already there (a worktree handled on an earlier run).
  async count(tk, cx) {
    const t = this.trees.get(tk);
    try {
      const files = await this.list(t);
      if (files === null) { t.state = "nofile"; return; }
      t.matched = files.length;
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
      const copied = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        const r = await exec("sh", ["-c", COPY, "sh", t.main, t.top, ...files.slice(i, i + CHUNK)], { on: t.on });
        copied.push(...(r.stdout ?? "").split("\n").filter(Boolean));
        if (r.code !== 0 && r.stderr) t.error = r.stderr.trim().split("\n")[0];
      }
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
    try { localStorage.setItem("done", JSON.stringify([...this.done].slice(-500))); } catch {}
  }

  copyFocused(cx) {
    const f = focused();
    const s = spaces().find((x) => x.id === f?.space);
    const tk = s && this.places.get(key(s.machine, place(s)));
    if (tk) cx.spawn(async (cx) => { await this.copy(tk, false, cx); });
    else notify({ title: "Not a worktree", body: "This space isn't a linked git worktree.", level: "info" });
  }

  tilde(p) {
    return this.userHome && p.startsWith(this.userHome) ? `~${p.slice(this.userHome.length)}` : p;
  }

  render(cx) {
    const t = theme();
    // Trees with a space open now, grouped by their repo's main checkout.
    const live = new Map();
    for (const s of spaces()) {
      const p = place(s);
      const tk = p && this.places.get(key(s.machine, p));
      if (tk && this.trees.has(tk) && !live.has(tk)) live.set(tk, s);
    }
    const repos = new Map();
    for (const [tk, s] of live) {
      const tr = this.trees.get(tk);
      const rk = key(tr.on, tr.main);
      if (!repos.has(rk)) repos.set(rk, { main: tr.main, on: tr.on, rows: [] });
      repos.get(rk).rows.push([tk, tr, s]);
    }

    const status = (tr) => {
      switch (tr.state) {
        case "new":
        case "copying": return div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
        case "nofile": return div().text_color(t.dim).child("no list");
        case "toomany": return div().text_color(t.blocked).child(`${tr.matched} files: click`);
        case "error": return div().text_color(t.blocked).child("failed");
        default:
          return tr.copied.length
            ? div().text_color(t.done).child(`+${tr.copied.length}`)
            : div().text_color(t.muted).child(tr.matched ? `${tr.matched} ✓` : "nothing");
      }
    };

    const row = ([tk, tr, s]) => {
      const unfolded = this.open.has(tk);
      return v_flex()
        .child(
          h_flex().id(`w-${tk}`).h(28).px(10).gap(8).items_center().rounded(6)
            .when(s.active, (el) => el.bg(t.selected))
            .hover((el) => el.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => run("space.select", { id: s.id }))
            .child(div().text_color(t.dim).child(unfolded ? "▾" : "▸").id(`f-${tk}`).w(10)
              .on_click((e, cx) => { cx.stop_propagation(); unfolded ? this.open.delete(tk) : this.open.add(tk); cx.notify(); }))
            .child(div().flex_1().truncate().text_color(s.active ? t.foreground : t.muted).child(tr.branch))
            .child(status(tr).text_size(12))
            .child(
              div().id(`c-${tk}`).px(6).h(20).rounded(4).items_center().flex().text_size(11)
                .text_color(t.muted).border(1).border_color(t.border)
                .hover((el) => el.bg(t.raised).text_color(t.foreground))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => { await this.copy(tk, false, cx); }); })
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
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click(() => closeOverlay(props().overlay))
                .child("×")))))
      .child(
        v_flex().flex_1().id("list").overflow_y_scrollbar().p(6).gap(10)
          .when(repos.size === 0, (el) => el.child(
            v_flex().p(8).gap(6).text_size(12).text_color(t.muted)
              .child(div().child("No worktree spaces open."))
              .child(div().text_color(t.dim).child(`Make one with New worktree. Gitignored files that match the repo's ${FILE} are copied into it.`))))
          .children([...repos.values()].map((r) =>
            v_flex().gap(2)
              .child(h_flex().px(10).h(22).gap(6).items_center().text_size(11).text_color(t.dim)
                .child(div().font_semibold().text_color(t.muted).child(base(r.main).toUpperCase()))
                .child(div().truncate().child(r.on ? `${r.on}:${this.tilde(r.main)}` : this.tilde(r.main))))
              .children(r.rows.map(row)))));
  }
}

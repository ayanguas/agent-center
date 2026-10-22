#!/usr/bin/env python3
"""Organizer — lightweight task management across projects.

Tasks live in `TASKS.md` at the root of each registered project, plus a global
`inbox.md` for unassigned items. Standard GitHub markdown syntax:

    - [ ] Text !high @2026-04-30 #tag  <!-- added: 2026-04-28 -->  <!-- session: <uuid> -->

The `session` comment is the Claude Code session the task was captured in
($CLAUDE_CODE_SESSION_ID, or --session); Agent Center links them.

Subcommands:
    add <text>             Add a task to current project (or inbox if outside one)
    list [--all]           List open tasks (current project, or every registered)
    done <idx | proj:idx>  Mark task complete and move to archive
    done-at <file> <line>  Same, by file and line (for tools; --text guards it)
    reopen-at <file> <line>  Undo done-at (reopens the line, drops its archive entry)
    edit <idx> <text>      Replace the text of a task (preserves metadata trail)
    move <idx> <proj>      Move a task between projects/inbox
    register [<path>]      Register a project path (defaults to cwd)
    unregister [<path>]    Drop a project from the registry
    dashboard              Regenerate dashboard.md from all registered projects
    stale [--days N]       Show tasks older than N days (default 14)
    stats                  Print quick activity stats
    context [--cwd P]      Print a session-start context block (for an optional SessionStart hook)
    queue-pop              Print and clear the auto-capture queue (for an optional review step)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import re
import sys
from dataclasses import dataclass, field
from typing import Optional

HOME = pathlib.Path.home()
ROOT = HOME / "organizer"
CONFIG = ROOT / "config.json"
INBOX = ROOT / "inbox.md"
DASHBOARD = ROOT / "dashboard.md"
ARCHIVE = ROOT / "archive"
QUEUE = ROOT / ".queue.jsonl"

INBOX_KEY = "inbox"

TASK_RE = re.compile(r"^([ \t]*)[-*]\s\[( |x|X)\]\s+(.*)$")
META_RE = re.compile(r"<!--.*?-->")
PRIO_RE = re.compile(r"(?<!\S)!(high|med|medium|low)(?!\S)", re.IGNORECASE)
DUE_RE = re.compile(r"(?<!\S)@(\d{4}-\d{2}-\d{2})(?!\S)")
TAG_RE = re.compile(r"(?<!\S)#([A-Za-z][\w-]*)(?!\S)")
ADDED_RE = re.compile(r"added:\s*(\d{4}-\d{2}-\d{2})")
DONE_RE = re.compile(r"done:\s*(\d{4}-\d{2}-\d{2})")

PRIO_RANK = {"high": 0, "medium": 1, "med": 1, "low": 2, None: 3}
PRIO_NORM = {"high": "high", "medium": "med", "med": "med", "low": "low"}


# ---------------- model ----------------

@dataclass
class Task:
    is_open: bool
    raw: str            # original line incl. checkbox + comments
    line_no: int        # 1-indexed line in source file
    indent: str         # leading whitespace ("" for top-level)
    body: str           # text after checkbox, before HTML comments

    @property
    def text(self) -> str:
        """Display text: body with priority/tag/due markers preserved but
        comments stripped."""
        return META_RE.sub("", self.body).strip()

    @property
    def clean_text(self) -> str:
        """Just the prose: priority/tag/due markers removed too."""
        t = META_RE.sub("", self.body)
        t = PRIO_RE.sub("", t)
        t = DUE_RE.sub("", t)
        t = TAG_RE.sub("", t)
        return re.sub(r"\s+", " ", t).strip()

    @property
    def priority(self) -> Optional[str]:
        m = PRIO_RE.search(self.body)
        return PRIO_NORM[m.group(1).lower()] if m else None

    @property
    def due(self) -> Optional[_dt.date]:
        m = DUE_RE.search(self.body)
        if not m:
            return None
        try:
            return _dt.date.fromisoformat(m.group(1))
        except ValueError:
            return None

    @property
    def tags(self) -> list[str]:
        return [m.group(1) for m in TAG_RE.finditer(self.body)]

    @property
    def added(self) -> Optional[_dt.date]:
        m = ADDED_RE.search(self.raw)
        if not m:
            return None
        try:
            return _dt.date.fromisoformat(m.group(1))
        except ValueError:
            return None

    @property
    def is_overdue(self) -> bool:
        return self.is_open and self.due is not None and self.due < _dt.date.today()

    @property
    def is_subtask(self) -> bool:
        return bool(self.indent)

    def sort_key(self) -> tuple:
        # overdue first → priority → due asc → added asc → line
        prio = PRIO_RANK[self.priority] if self.priority else PRIO_RANK[None]
        overdue = 0 if self.is_overdue else 1
        due_ord = self.due.toordinal() if self.due else 10**9
        added_ord = self.added.toordinal() if self.added else 10**9
        return (overdue, prio, due_ord, added_ord, self.line_no)


# ---------------- io helpers ----------------

def today() -> str:
    return _dt.date.today().isoformat()


def now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def atomic_write(path: pathlib.Path, content: str) -> None:
    """Write `content` to `path` via tmp + os.replace for crash safety."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content)
    os.replace(tmp, path)


def load_config() -> dict:
    if not CONFIG.exists():
        return {"projects": []}
    try:
        return json.loads(CONFIG.read_text())
    except json.JSONDecodeError:
        return {"projects": []}


def save_config(cfg: dict) -> None:
    atomic_write(CONFIG, json.dumps(cfg, indent=2) + "\n")


def registered_projects() -> list[pathlib.Path]:
    return [pathlib.Path(p) for p in load_config().get("projects", [])]


def find_project_root(cwd: Optional[str] = None) -> Optional[pathlib.Path]:
    start = pathlib.Path(cwd or os.getcwd()).resolve()
    registered = {p.resolve() for p in registered_projects()}
    for parent in [start, *start.parents]:
        if parent in registered:
            return parent
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            return parent
    return None


def ensure_tasks_file(path: pathlib.Path, title: str) -> None:
    if not path.exists():
        atomic_write(path, f"# {title} — Tasks\n\n## Open\n\n## Done\n\n")


def ensure_inbox() -> None:
    if not INBOX.exists():
        atomic_write(INBOX, "# Inbox\n\n## Open\n\n## Done\n\n")


def append_under_open(file: pathlib.Path, line: str) -> None:
    text = file.read_text()
    if "## Open" not in text:
        text += "\n## Open\n\n"
    head, _, rest = text.partition("## Open")
    rest_lines = rest.splitlines(keepends=True)
    new_rest = "".join(rest_lines[:1]) + line + "\n" + "".join(rest_lines[1:])
    atomic_write(file, head + "## Open" + new_rest)


def parse_tasks(file: pathlib.Path, *, include_subtasks: bool = False) -> list[Task]:
    if not file.exists():
        return []
    out: list[Task] = []
    for i, raw in enumerate(file.read_text().splitlines(), start=1):
        m = TASK_RE.match(raw)
        if not m:
            continue
        indent, mark, body = m.group(1), m.group(2), m.group(3).rstrip()
        t = Task(is_open=(mark == " "), raw=raw, line_no=i, indent=indent, body=body)
        if not include_subtasks and t.is_subtask:
            continue
        out.append(t)
    return out


def open_tasks_sorted(file: pathlib.Path) -> list[Task]:
    return sorted((t for t in parse_tasks(file) if t.is_open), key=Task.sort_key)


# ---------------- project resolution ----------------

def project_by_name(name: str) -> Optional[pathlib.Path]:
    """Resolve a short name (e.g. 'contracts-service' or 'inbox') to a project
    path or None for inbox sentinel."""
    if name == INBOX_KEY:
        return None
    matches = [p for p in registered_projects() if p.name == name]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        # tolerate partial match if unique
        partial = [p for p in registered_projects() if name in p.name]
        if len(partial) == 1:
            return partial[0]
    return None


def file_for_scope(scope: Optional[pathlib.Path]) -> pathlib.Path:
    return INBOX if scope is None else (scope / "TASKS.md")


def scope_label(scope: Optional[pathlib.Path]) -> str:
    return INBOX_KEY if scope is None else scope.name


# ---------------- formatters ----------------

def render_task(t: Task, *, with_age: bool = False) -> str:
    parts = []
    if t.priority:
        sigil = {"high": "‼", "med": "·", "low": "↓"}.get(t.priority, "")
        parts.append(sigil)
    if t.is_overdue:
        parts.append("⚠")
    elif t.due:
        delta = (t.due - _dt.date.today()).days
        if delta <= 3:
            parts.append(f"@{t.due.isoformat()}({'+' if delta>=0 else ''}{delta}d)")
    head = " ".join(parts)
    text = t.clean_text or t.text
    line = f"{head} {text}".strip()
    if t.tags:
        line += "  " + " ".join(f"#{x}" for x in t.tags)
    if with_age and t.added:
        age = (_dt.date.today() - t.added).days
        line += f"  ({age}d)"
    return line


# ---------------- commands ----------------

def cmd_add(args) -> int:
    text = (args.text or "").strip()
    if not text:
        print("error: empty task text", file=sys.stderr)
        return 1
    if args.to:
        scope = project_by_name(args.to)
        if scope is None and args.to != INBOX_KEY:
            print(f"error: unknown project '{args.to}' (see `organizer.py list --all` for the names)", file=sys.stderr)
            return 1
        target = file_for_scope(scope)
        if scope is None:
            ensure_inbox()
        else:
            ensure_tasks_file(target, scope.name)
        scope_str = scope_label(scope)
    elif args.inbox:
        ensure_inbox()
        target = INBOX
        scope_str = INBOX_KEY
    else:
        project = find_project_root()
        if project:
            target = project / "TASKS.md"
            ensure_tasks_file(target, project.name)
            cfg = load_config()
            paths = {pathlib.Path(p).resolve() for p in cfg["projects"]}
            if project.resolve() not in paths:
                cfg["projects"].append(str(project))
                save_config(cfg)
            scope_str = project.name
        else:
            ensure_inbox()
            target = INBOX
            scope_str = "inbox (no project detected)"
    line = f"- [ ] {text}  <!-- added: {today()} -->"
    session = getattr(args, "session", None) or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if session:
        line += f"  <!-- session: {session} -->"
    append_under_open(target, line)
    rel = target.relative_to(HOME) if str(target).startswith(str(HOME)) else target
    print(f"✓ added to {scope_str} → ~/{rel}")
    return 0


def _print_scope_block(scope: Optional[pathlib.Path]) -> int:
    name = scope_label(scope)
    icon = "📥" if scope is None else "📁"
    tasks = open_tasks_sorted(file_for_scope(scope))
    if not tasks:
        return 0
    print(f"\n{icon} {name} ({len(tasks)})" + (f"  {scope}" if scope else ""))
    for i, t in enumerate(tasks):
        print(f"   [{name}:{i}] {render_task(t)}")
    return len(tasks)


def cmd_list(args) -> int:
    if args.all:
        total = 0
        total += _print_scope_block(None)
        for proj in registered_projects():
            total += _print_scope_block(proj)
        if total == 0:
            print("(no open tasks)")
        return 0

    project = find_project_root()
    scope = project  # may be None
    name = scope_label(scope)
    tasks = open_tasks_sorted(file_for_scope(scope))
    icon = "📥" if scope is None else "📁"
    print(f"{icon} {name} — {len(tasks)} open")
    for i, t in enumerate(tasks):
        print(f"  [{i}] {render_task(t)}")
    return 0


def _resolve_done_target(arg: str) -> tuple[Optional[pathlib.Path], int]:
    """Parse '<idx>' or '<name>:<idx>'. Returns (scope_or_None, idx)."""
    if ":" in arg:
        name, _, raw_idx = arg.partition(":")
        scope = project_by_name(name)
        if scope is None and name != INBOX_KEY:
            raise ValueError(f"unknown project '{name}'")
    else:
        scope = find_project_root()
        raw_idx = arg
    return scope, int(raw_idx)


def cmd_done(args) -> int:
    try:
        scope, idx = _resolve_done_target(args.id)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    target = file_for_scope(scope)
    tasks = open_tasks_sorted(target)
    if idx < 0 or idx >= len(tasks):
        print(f"error: index {idx} out of range (0..{len(tasks)-1})", file=sys.stderr)
        return 1
    return _close(target, scope, tasks[idx])


def _scope_for_file(file: str) -> tuple[pathlib.Path, Optional[pathlib.Path]]:
    """The tasks file and its scope; raises ValueError for any other file."""
    target = pathlib.Path(file).expanduser().resolve()
    projects = {p.resolve(): p for p in registered_projects()}
    if target == INBOX.resolve():
        return target, None
    if target.name == "TASKS.md" and target.parent in projects:
        return target, projects[target.parent]
    raise ValueError(f"{target} is neither the inbox nor a registered TASKS.md")


def cmd_done_at(args) -> int:
    try:
        target, scope = _scope_for_file(args.file)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    chosen = next((t for t in parse_tasks(target) if t.line_no == args.line and t.is_open), None)
    if chosen is None or (args.text is not None and chosen.clean_text != args.text):
        print(f"error: no matching open task at {target}:{args.line}", file=sys.stderr)
        return 1
    return _close(target, scope, chosen)


def cmd_reopen_at(args) -> int:
    """Undo done-at: reopen the line and drop its newest archive entry."""
    try:
        target, scope = _scope_for_file(args.file)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    chosen = next((t for t in parse_tasks(target) if t.line_no == args.line and not t.is_open), None)
    if chosen is None or (args.text is not None and chosen.clean_text != args.text):
        print(f"error: no matching done task at {target}:{args.line}", file=sys.stderr)
        return 1
    lines = target.read_text().splitlines(keepends=True)
    raw_idx = chosen.line_no - 1
    line = re.sub(r"-\s\[[xX]\]", "- [ ]", lines[raw_idx], count=1)
    lines[raw_idx] = re.sub(r"\s*<!--\s*done:[^>]*-->", "", line.rstrip("\n")) + "\n"
    atomic_write(target, "".join(lines))
    entry = f"- [x] [{scope_label(scope)}] {chosen.clean_text}"
    for month in sorted(ARCHIVE.glob("*.md"), reverse=True):
        archived = month.read_text().splitlines(keepends=True)
        hits = [i for i, l in enumerate(archived) if l.startswith(entry)]
        if hits:
            del archived[hits[-1]]
            atomic_write(month, "".join(archived))
            break
    print(f"✓ reopened: {chosen.clean_text}")
    return 0


def _close(target: pathlib.Path, scope: Optional[pathlib.Path], chosen: Task) -> int:
    lines = target.read_text().splitlines(keepends=True)
    raw_idx = chosen.line_no - 1
    new_line = re.sub(r"-\s\[ \]", "- [x]", lines[raw_idx], count=1).rstrip("\n") \
        + f"  <!-- done: {today()} -->\n"
    lines[raw_idx] = new_line
    atomic_write(target, "".join(lines))
    ARCHIVE.mkdir(exist_ok=True)
    month = ARCHIVE / f"{_dt.date.today().strftime('%Y-%m')}.md"
    src = scope_label(scope)
    existing = month.read_text() if month.exists() else f"# Archive {month.stem}\n\n"
    existing += f"- [x] [{src}] {chosen.clean_text}  <!-- done: {today()} -->\n"
    atomic_write(month, existing)
    print(f"✓ done: {chosen.clean_text}")
    return 0


def cmd_edit(args) -> int:
    try:
        scope, idx = _resolve_done_target(args.id)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    new_text = (args.text or "").strip()
    if not new_text:
        print("error: empty new text", file=sys.stderr)
        return 1
    target = file_for_scope(scope)
    tasks = open_tasks_sorted(target)
    if idx < 0 or idx >= len(tasks):
        print(f"error: index {idx} out of range (0..{len(tasks)-1})", file=sys.stderr)
        return 1
    chosen = tasks[idx]
    lines = target.read_text().splitlines(keepends=True)
    raw_idx = chosen.line_no - 1
    # preserve any HTML comment trail (e.g. added: ...)
    m = re.search(r"\s*<!--.*?-->\s*$", lines[raw_idx])
    trail = m.group(0).rstrip("\n") if m else f"  <!-- added: {today()} -->"
    lines[raw_idx] = f"{chosen.indent}- [ ] {new_text}{trail}\n"
    atomic_write(target, "".join(lines))
    print(f"✓ edited [{scope_label(scope)}:{idx}] → {new_text}")
    return 0


def cmd_move(args) -> int:
    try:
        scope_src, idx = _resolve_done_target(args.id)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    dest_name = args.to
    if dest_name == INBOX_KEY:
        scope_dst: Optional[pathlib.Path] = None
    else:
        scope_dst = project_by_name(dest_name)
        if scope_dst is None:
            print(f"error: unknown destination '{dest_name}'", file=sys.stderr)
            return 1
    src_file = file_for_scope(scope_src)
    dst_file = file_for_scope(scope_dst)
    tasks = open_tasks_sorted(src_file)
    if idx < 0 or idx >= len(tasks):
        print(f"error: index {idx} out of range (0..{len(tasks)-1})", file=sys.stderr)
        return 1
    chosen = tasks[idx]
    # remove from src
    src_lines = src_file.read_text().splitlines(keepends=True)
    moved_line = src_lines.pop(chosen.line_no - 1)
    atomic_write(src_file, "".join(src_lines))
    # ensure dst exists
    if scope_dst is None:
        ensure_inbox()
    else:
        ensure_tasks_file(dst_file, scope_dst.name)
    # append the original line under Open of destination, stripped of trailing newline
    append_under_open(dst_file, moved_line.rstrip("\n"))
    print(f"✓ moved [{scope_label(scope_src)}:{idx}] → {scope_label(scope_dst)}")
    return 0


def cmd_register(args) -> int:
    path = pathlib.Path(args.path or os.getcwd()).resolve()
    if not path.is_dir():
        print(f"error: {path} is not a directory", file=sys.stderr)
        return 1
    cfg = load_config()
    paths = {pathlib.Path(p).resolve() for p in cfg["projects"]}
    if path in paths:
        print(f"already registered: {path}")
        return 0
    cfg["projects"].append(str(path))
    save_config(cfg)
    ensure_tasks_file(path / "TASKS.md", path.name)
    print(f"✓ registered: {path}  (add TASKS.md to your global git ignore if it should stay out of the repo)")
    return 0


def cmd_unregister(args) -> int:
    path = pathlib.Path(args.path or os.getcwd()).resolve()
    cfg = load_config()
    before = len(cfg.get("projects", []))
    cfg["projects"] = [p for p in cfg.get("projects", []) if pathlib.Path(p).resolve() != path]
    if len(cfg["projects"]) == before:
        # try matching by name if exact path miss
        cfg["projects"] = [p for p in cfg.get("projects", []) if pathlib.Path(p).name != path.name]
        if len(cfg["projects"]) == before:
            print(f"not registered: {path}", file=sys.stderr)
            return 1
    save_config(cfg)
    print(f"✓ unregistered: {path}  (TASKS.md not deleted)")
    return 0


def cmd_dashboard(args) -> int:
    inbox_tasks = open_tasks_sorted(INBOX)
    proj_blocks = []
    total_open = len(inbox_tasks)
    active_projects = 0
    for proj in registered_projects():
        opens = open_tasks_sorted(proj / "TASKS.md")
        if opens:
            proj_blocks.append((proj, opens))
            total_open += len(opens)
            active_projects += 1
    out = [
        "# Dashboard",
        f"_generated: {now_iso()}_",
        "",
        f"**{total_open} open · {active_projects} active / {len(registered_projects())} registered projects**",
        "",
    ]
    if inbox_tasks:
        out.append("## 📥 Inbox")
        for t in inbox_tasks:
            out.append(f"- [ ] {render_task(t, with_age=True)}")
        out.append("")
    for proj, opens in proj_blocks:
        out.append(f"## 📁 {proj.name}")
        out.append(f"`{proj}`")
        out.append("")
        for t in opens:
            out.append(f"- [ ] {render_task(t, with_age=True)}")
        out.append("")
    atomic_write(DASHBOARD, "\n".join(out))
    print(f"✓ dashboard updated → {DASHBOARD}  ({total_open} open)")
    return 0


def cmd_stale(args) -> int:
    days = args.days
    cutoff = _dt.date.today() - _dt.timedelta(days=days)
    found = 0
    for scope in [None, *registered_projects()]:
        for t in open_tasks_sorted(file_for_scope(scope)):
            if t.added and t.added <= cutoff:
                age = (_dt.date.today() - t.added).days
                print(f"[{age}d] {scope_label(scope)}: {t.clean_text}")
                found += 1
    if not found:
        print(f"(no tasks older than {days} days)")
    return 0


def cmd_stats(args) -> int:
    today_d = _dt.date.today()
    week_ago = today_d - _dt.timedelta(days=7)
    open_count = 0
    overdue = 0
    high_open = 0
    added_7d = 0
    done_7d = 0
    for scope in [None, *registered_projects()]:
        for t in parse_tasks(file_for_scope(scope)):
            if t.is_open:
                open_count += 1
                if t.is_overdue:
                    overdue += 1
                if t.priority == "high":
                    high_open += 1
                if t.added and t.added >= week_ago:
                    added_7d += 1
            else:
                m = DONE_RE.search(t.raw)
                if m:
                    try:
                        if _dt.date.fromisoformat(m.group(1)) >= week_ago:
                            done_7d += 1
                    except ValueError:
                        pass
    print(f"open: {open_count}  (high: {high_open}, overdue: {overdue})")
    print(f"last 7d: +{added_7d} added  ✓{done_7d} done")
    return 0


def cmd_context(args) -> int:
    project = find_project_root(args.cwd)
    lines = []
    if project:
        opens = open_tasks_sorted(project / "TASKS.md")
        if opens:
            lines.append(f"📋 Open tasks for {project.name} ({len(opens)}):")
            for t in opens[:15]:
                lines.append(f"  • {render_task(t)}")
            if len(opens) > 15:
                lines.append(f"  … and {len(opens)-15} more")
    inbox_opens = open_tasks_sorted(INBOX)
    if inbox_opens:
        if lines:
            lines.append("")
        lines.append(f"📥 Inbox ({len(inbox_opens)} unassigned):")
        for t in inbox_opens[:5]:
            lines.append(f"  • {render_task(t)}")
        if len(inbox_opens) > 5:
            lines.append(f"  … and {len(inbox_opens)-5} more")
    pending = 0
    if QUEUE.exists():
        with QUEUE.open() as f:
            pending = sum(1 for _ in f)
    if pending:
        if lines:
            lines.append("")
        lines.append(f"⏳ {pending} session(s) pending auto-capture — see `organizer.py queue-pop`.")
    if lines:
        print("\n".join(lines))
    return 0


def cmd_queue_pop(args) -> int:
    if not QUEUE.exists():
        return 0
    sys.stdout.write(QUEUE.read_text())
    QUEUE.unlink()
    return 0


# ---------------- argparse ----------------

def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="organizer")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("add")
    s.add_argument("text", nargs="+")
    s.add_argument("--inbox", action="store_true")
    s.add_argument("--to", help="add to a specific project (by name) instead of cwd")
    s.add_argument("--session", help="Claude Code session id (default: $CLAUDE_CODE_SESSION_ID)")
    s.set_defaults(func=lambda a: cmd_add(argparse.Namespace(text=" ".join(a.text), inbox=a.inbox, to=a.to, session=a.session)))

    s = sub.add_parser("list"); s.add_argument("--all", action="store_true"); s.set_defaults(func=cmd_list)
    s = sub.add_parser("done"); s.add_argument("id"); s.set_defaults(func=cmd_done)
    s = sub.add_parser("done-at")
    s.add_argument("file")
    s.add_argument("line", type=int)
    s.add_argument("--text", help="expected task text; refuse if the line changed")
    s.set_defaults(func=cmd_done_at)
    s = sub.add_parser("reopen-at")
    s.add_argument("file")
    s.add_argument("line", type=int)
    s.add_argument("--text", help="expected task text; refuse if the line changed")
    s.set_defaults(func=cmd_reopen_at)

    s = sub.add_parser("edit")
    s.add_argument("id")
    s.add_argument("text", nargs="+")
    s.set_defaults(func=lambda a: cmd_edit(argparse.Namespace(id=a.id, text=" ".join(a.text))))

    s = sub.add_parser("move")
    s.add_argument("id")
    s.add_argument("to")
    s.set_defaults(func=cmd_move)

    s = sub.add_parser("register"); s.add_argument("path", nargs="?"); s.set_defaults(func=cmd_register)
    s = sub.add_parser("unregister"); s.add_argument("path", nargs="?"); s.set_defaults(func=cmd_unregister)
    s = sub.add_parser("dashboard"); s.set_defaults(func=cmd_dashboard)
    s = sub.add_parser("stale"); s.add_argument("--days", type=int, default=14); s.set_defaults(func=cmd_stale)
    s = sub.add_parser("stats"); s.set_defaults(func=cmd_stats)
    s = sub.add_parser("context"); s.add_argument("--cwd"); s.set_defaults(func=cmd_context)
    s = sub.add_parser("queue-pop"); s.set_defaults(func=cmd_queue_pop)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

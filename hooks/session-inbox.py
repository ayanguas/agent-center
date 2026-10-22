#!/usr/bin/env python3
"""Session inbox: record, per Claude Code session, whether it waits for the user.

One JSON file per session in ~/.claude/session-inbox/<session_id>.json; this
hook is its only writer. Agent Center reads that folder and keeps the
person's own state (pins, parks, done) in its own data/board.json. Wired in
~/.claude/settings.json on UserPromptSubmit, Stop, Notification, SessionEnd,
and PreToolUse / PostToolUse for the tools that wait for the person (see
interactive_ask). Never blocks, never prints. Python 3.8 or newer.

States:
  working     Claude is on a turn (or has background work that will wake it)
  asking      the turn ended with a question for the user
  permission  Claude waits for a tool approval
  done        the turn ended with no explicit question
"""
import fcntl
import json
import os
import pathlib
import re
import sys
import tempfile
import time

INBOX = pathlib.Path.home() / ".claude" / "session-inbox"
TAIL_BYTES = 600_000


def now_ms() -> int:
    return int(time.time() * 1000)


def clip(text, n):
    if not text:
        return None
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def load(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def save(path: pathlib.Path, entry: dict) -> None:
    """Written aside under a unique name, then renamed: a reader never sees half a file."""
    fd, tmp = tempfile.mkstemp(dir=INBOX, prefix=f".{path.stem}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(entry, ensure_ascii=False))
        os.replace(tmp, path)
    except Exception:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def is_prompt_row(row: dict) -> bool:
    """A user row the person typed (not a tool result, not injected meta)."""
    if row.get("type") != "user" or row.get("isMeta"):
        return False
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(b.get("type") == "text" for b in content if isinstance(b, dict)) and not any(
            b.get("type") == "tool_result" for b in content if isinstance(b, dict)
        )
    return False


def last_wrap_up(transcript_path: str):
    """The desktop app's wrap_up call of the last turn: (ask, recap, choices).

    choices are the reply buttons it offered: [{label, message}], app actions
    (commit, create_pr...) left out since only the app can run those."""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return None, None, []
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except Exception:
            continue
        if is_prompt_row(row):
            break
        if row.get("type") != "assistant":
            continue
        for block in (row.get("message") or {}).get("content") or []:
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and str(block.get("name", "")).endswith("ccd_turn__wrap_up")
            ):
                data = block.get("input") or {}
                choices = [
                    {"label": clip(a.get("label"), 40), "message": clip(a.get("message") or a.get("label"), 300)}
                    for a in data.get("actions") or []
                    if isinstance(a, dict) and a.get("label") and not a.get("action")
                ][:3]
                return data.get("ask"), data.get("recap"), choices
    return None, None, []


def question_in(text: str):
    """The last real question in the closing paragraphs, or None.

    Only prose counts: a "?" inside a link (example.com/?utm=...), inside code
    or inside quotes is not a question, and a question has at least three
    words (letters of any language). Those parts are blanked (same length)
    only to find the question; the question is returned as written."""
    if not text:
        return None
    tail = "\n".join(p for p in text.strip().split("\n\n")[-2:])
    blank = lambda m: " " * len(m.group(0))
    masked = re.sub(r"```.*?```|`[^`]*`", blank, tail, flags=re.S)  # code
    masked = re.sub(r"\]\([^)]*\)", blank, masked)  # markdown link targets
    masked = re.sub(r"\S*[/=&]\S*\?\S*|\S+\?[\w=&%-]+\S*|https?://\S+", blank, masked)  # URLs
    masked = re.sub(r'"[^"\n]{0,40}"|«[^»\n]{0,40}»|“[^”\n]{0,40}”', blank, masked)  # quoted bits
    for m in reversed(list(re.finditer(r"[^.!?\n]*\?", masked))):
        if len(re.findall(r"[^\W\d_]{2,}", m.group(0))) >= 3:
            return tail[m.start():m.end()].strip(" -*>#")
    return None


def first_line(text: str):
    for line in (text or "").splitlines():
        line = line.strip(" #*>-")
        if line:
            return line
    return None


def interactive_ask(tool: str, tool_input: dict):
    """What a tool that waits for the person in the desktop app asks, or None.

    These tools hold the turn until the person answers in the app, so the
    session waits for them even though no Stop arrives."""
    if tool == "AskUserQuestion":
        questions = tool_input.get("questions") or []
        return questions[0].get("question") if questions else "Claude asks you a question"
    if tool == "ExitPlanMode":
        return "Approve the plan"
    if tool.endswith("ccd_directory__propose_branch"):
        return f"Choose a branch: {tool_input.get('suggested') or 'a new branch or the current one'}"
    if tool.endswith("ccd_directory__change_directory"):
        return f"Approve the folder {tool_input.get('path') or ''}".strip()
    if tool.endswith("ccd_directory__request_directory"):
        return "Choose a folder"
    if tool.endswith("ccd_session__start_session") and tool_input.get("initiation") == "offer":
        return f"Open a new session? {tool_input.get('title') or ''}".strip()
    return None


def main() -> None:
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk") and not os.environ.get("AGENT_CENTER_LAUNCH"):
        return  # headless `claude -p` / SDK runs: nobody to answer (unless Agent Center launched it)
    data = json.load(sys.stdin)
    if data.get("agent_id"):
        return  # subagent events
    sid = data.get("session_id")
    if not sid:
        return
    event = data.get("hook_event_name")
    path = INBOX / f"{sid}.json"

    if event == "SessionEnd":
        if data.get("reason") == "clear" and path.exists():
            path.unlink()
        return

    # Events of one session can run at once (a notification during a tool
    # call): one read-change-write at a time per session.
    INBOX.mkdir(parents=True, exist_ok=True)
    with open(INBOX / f".{sid}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        update(path, sid, event, data)


def update(path: pathlib.Path, sid: str, event: str, data: dict) -> None:
    entry = load(path)
    cwd = data.get("cwd") or entry.get("cwd") or ""
    entry.update(
        session_id=sid,
        host_session_id=os.environ.get("CLAUDE_CODE_HOST_SESSION_ID") or entry.get("host_session_id"),
        cwd=cwd,
        project=pathlib.Path(cwd).name or cwd,
        updated_at=now_ms(),
    )
    # The session's permission mode and effort, as the engine reports them on
    # each event that has them (the board shows and changes them).
    if data.get("permission_mode"):
        entry["mode"] = data.get("permission_mode")
    effort = data.get("effort")
    if isinstance(effort, dict) and effort.get("level"):
        entry["effort"] = effort.get("level")

    if event == "UserPromptSubmit":
        # The client may prepend a note of its own (e.g. after importing a
        # session); keep only what the person typed.
        prompt = re.sub(r"<system-reminder>.*?</system-reminder>", "", data.get("prompt") or "", flags=re.S).strip()
        if data.get("session_title"):
            entry["title"] = clip(data["session_title"], 80)
        elif not entry.get("title"):
            entry["title"] = clip(prompt, 60)
        entry.update(state="working", ask=None, summary=None, choices=[], ask_kind=None, last_prompt=clip(prompt, 200))
        entry.setdefault("first_prompt", clip(prompt, 200))

    elif event == "Stop":
        # Work left running in the background (shells, subagents): the
        # session is not done while it runs. Each keeps the time it was first
        # seen, across turns. Monitors are left out: they only watch (an
        # artifact, a log) and wake the session when something happens, which
        # is not work in progress.
        seen = {b.get("id"): b.get("since") for b in entry.get("background") or []}
        now = int(time.time() * 1000)
        background = [
            {
                "id": t.get("id"),
                "type": t.get("type"),
                "description": clip(t.get("description"), 160),
                "command": clip(t.get("command"), 200),
                "agent_type": t.get("agent_type"),
                "since": seen.get(t.get("id")) or now,
            }
            for t in data.get("background_tasks") or []
            if isinstance(t, dict) and t.get("type") != "monitor"
        ]
        message = data.get("last_assistant_message") or ""
        ask, recap, choices = last_wrap_up(data.get("transcript_path") or "")
        wrap_ask = ask
        choices = choices if ask else []
        ask = ask or question_in(message)
        entry.update(
            state="asking" if ask else "working" if background else "done",
            ask=clip(ask, 240),
            summary=clip(recap or first_line(message), 300),
            choices=choices,
            ask_kind=("next" if wrap_ask else "text") if ask else None,
            background=background,
            background_at=now,
        )

    elif event == "Notification":
        kind = data.get("notification_type") or ""
        if kind == "permission_prompt":
            entry.update(state="permission", ask=clip(data.get("message"), 240), choices=[], ask_kind="dialog")
        elif kind in ("", "elicitation_dialog"):
            # A question from an MCP server, or a notice from an engine too old to name its kind.
            entry.update(state="asking", ask=clip(data.get("message"), 240))
        else:
            return  # idle reminders, sign-in notices and kinds this hook does not know

    elif event == "PreToolUse" and interactive_ask(data.get("tool_name") or "", data.get("tool_input") or {}):
        text = interactive_ask(data.get("tool_name") or "", data.get("tool_input") or {})
        entry.update(state="asking", ask=clip(text, 240), choices=[], ask_kind="dialog")

    elif event == "PostToolUse" and interactive_ask(data.get("tool_name") or "", data.get("tool_input") or {}):
        entry.update(state="working", ask=None, ask_kind=None)

    else:
        return

    save(path, entry)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)

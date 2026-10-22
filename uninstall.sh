#!/bin/bash
# Agent Center uninstaller: stops the server and undoes what the setup added
# to Claude Code (hook entries, the uploads permission, the bridge mod). Asks
# before deleting any data. The organizer (~/organizer) and its note in
# ~/.claude/CLAUDE.md stay: they hold your tasks.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HOME/Library/Application Support/Agent Center"
LABEL="local.agent-center"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '%s\n' "$*"; }
ask() { read -r -p "$1 [y/N] " answer; [[ "$answer" =~ ^[yY] ]]; }

ask "Remove Agent Center from this Mac?" || exit 0

# Claude Code first: the hook entries, the rule for sent files, the bridge mod.
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
if [[ -x "$BUN" ]] && "$BUN" "$APP_DIR/scripts/uninstall.ts"; then
  rm -f "$HOME/.claude/hooks/session-inbox.py"
  say "Hook entries, the rule for sent files and the bridge mod removed."
  [[ -f "$HOME/.claude/settings.json.before-agent-center" ]] && say "Your settings.json from before Agent Center: ~/.claude/settings.json.before-agent-center"
else
  say "Could not undo the Claude Code changes (Bun is needed): remove the session-inbox.py entries from ~/.claude/settings.json and run: claude plugin uninstall agent-center-bridge@agent-center"
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
say "Server stopped."

if ask "Delete the board's own data (pins, notes, zones, logs, the dictation model) in $STATE?"; then
  rm -rf "$STATE"
fi
if ask "Delete what the board and the sessions exchanged (~/.claude/agent-center, the files you sent included, and ~/.claude/session-inbox)?"; then
  rm -rf "$HOME/.claude/agent-center" "$HOME/.claude/session-inbox"
fi

say "Done. The code folder ($APP_DIR) is yours to delete."

// Called by uninstall.sh: takes out of Claude Code what the setup added
// (lib/setup.ts undoAll).
import { undoAll } from "../lib/setup"

try {
  await undoAll()
} catch (err) {
  console.error(`Could not undo everything: ${(err as Error).message}`)
  process.exit(1)
}

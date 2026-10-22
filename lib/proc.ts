// Child processes. `exec` answers how a command ended (exit code, stdout,
// stderr) and never throws; `run` answers the stdout of a run that succeeded,
// or null. A run past its timeout is killed and ends with code null.

export type ExecResult = { code: number | null; stdout: string; stderr: string }

type ExecOptions = { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined>; input?: string }

export async function exec(cmd: string[], { cwd, timeoutMs = 8000, env, input }: ExecOptions = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
    if (input !== undefined) {
      proc.stdin!.write(input)
      proc.stdin!.end()
    }
    let isKilled = false
    const timer = setTimeout(() => ((isKilled = true), proc.kill()), timeoutMs)
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { code: isKilled ? null : code, stdout, stderr }
  } catch (err) {
    return { code: null, stdout: "", stderr: (err as Error).message }
  }
}

export async function run(cmd: string[], cwd: string, options: Omit<ExecOptions, "cwd"> = {}): Promise<string | null> {
  const result = await exec(cmd, { ...options, cwd })
  return result.code === 0 ? result.stdout.trim() : null
}

// The environment for a `claude` this server starts: without the variables of
// the Claude Code process that may have started the server, which would make
// the child think it runs inside that session.
export function claudeEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"]) delete env[key]
  return env
}

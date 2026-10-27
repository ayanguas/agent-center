// The "Code" tab's files (lib/code.ts): the tree with git's status, reading
// only inside the repository, and saving only what nobody changed meanwhile.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codeTree, readCode, saveCode } from "../lib/code"

let repo = ""
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "ac-code-"))
  await mkdir(join(repo, "src"))
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1\n")
  await writeFile(join(repo, "README.md"), "# Repo\n")
  await writeFile(join(repo, ".gitignore"), "ignored.log\n")
  git("init", "-q")
  git("add", ".")
  git("commit", "-q", "-m", "first")
  await writeFile(join(repo, "src", "a.ts"), "export const a = 2\n") // modified
  await writeFile(join(repo, "src", "b.ts"), "export const b = 1\n") // new
  await writeFile(join(repo, "ignored.log"), "noise\n")
  await writeFile(join(repo, "bin.dat"), Buffer.from([1, 0, 2]))
  await symlink("/etc/hosts", join(repo, "hosts-link"))
})
afterAll(() => rm(repo, { recursive: true, force: true }))

test("lists what git sees, with its status", async () => {
  const tree = await codeTree(join(repo, "src"))
  expect(tree.isGit).toBe(true)
  expect(tree.files).toContain("src/a.ts")
  expect(tree.files).toContain("src/b.ts")
  expect(tree.files).not.toContain("ignored.log")
  expect(tree.status["src/a.ts"]).toBe("M")
  expect(tree.status["src/b.ts"]).toBe("U")
})

test("reads only inside the repository", async () => {
  expect((await readCode(repo, "src/a.ts")).text).toBe("export const a = 2\n")
  expect((await readCode(repo, "../../etc/hosts")).status).toBe(404)
  expect((await readCode(repo, "hosts-link")).status).toBe(404) // a link out of it
  expect((await readCode(repo, "bin.dat")).binary).toBe(true)
})

test("saves only what nobody changed since it was read", async () => {
  const read = await readCode(repo, "README.md")
  expect((await saveCode(repo, "README.md", "# Mine\n", read.mtime!, false)).ok).toBe(true)
  await Bun.sleep(20)
  await writeFile(join(repo, "README.md"), "# Claude's\n") // changed meanwhile
  const stale = await saveCode(repo, "README.md", "# Mine again\n", read.mtime!, false)
  expect(stale.conflict).toBe(true)
  expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# Claude's\n")
  expect((await saveCode(repo, "README.md", "# Mine again\n", 0, true)).ok).toBe(true) // "Keep mine"
  expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# Mine again\n")
})

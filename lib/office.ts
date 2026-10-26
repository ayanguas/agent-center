// Previews of files the browser cannot show, made with what macOS has:
// Word and other text documents as a page (textutil), Excel workbooks as
// tables read straight from their XML (an .xlsx is a zip), and anything else
// Quick Look knows (PowerPoint, Keynote, Numbers, Pages…) as the picture
// Finder shows for it. The page answers them in a sandbox: no script runs.

import { mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { exec } from "./proc"

const MAX_ROWS = 1000
const MAX_COLS = 60

export const WORD = /^(docx|doc|rtf|rtfd|odt|wordml|webarchive)$/
export const WORKBOOK = /^(xlsx|xlsm)$/

// The pages below are drawn in a shadow root (public/js/files.js): no
// <body> there, so their styles go on a wrapping .page.
const READING = `<style>
  .page { font: 15px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; color: #1d1d1f; background: #fff; max-width: 820px; margin: 0 auto; padding: 28px 32px 60px; }
  .page img { max-width: 100%; height: auto; } .page table { border-collapse: collapse; } .page td, .page th { border: 1px solid #ddd; padding: 4px 8px; vertical-align: top; }
</style>`

// A Word (or RTF, ODT…) document as one HTML page: its own styles, then its
// body in a .page.
export async function documentHtml(path: string) {
  const out = await exec(["/usr/bin/textutil", "-convert", "html", "-stdout", path], { timeoutMs: 20_000 })
  if (out.code !== 0 || !out.stdout) throw new Error("macOS could not read this document")
  const styles = [...out.stdout.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map(m => m[0]).join("")
  const body = out.stdout.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? out.stdout
  return `${styles}${READING}<div class="page">${body}</div>`
}

const unzipped = async (path: string, entry: string) => {
  const out = await exec(["/usr/bin/unzip", "-p", path, entry], { timeoutMs: 20_000 })
  return out.code === 0 ? out.stdout : ""
}
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITY[e] ?? all))
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unxml(m[1]!)).join("")
// "B12" → column 1 (A is 0).
const columnOf = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
const letters = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))

// An Excel workbook as tables, one per sheet, with an index of sheets on top.
export async function workbookHtml(path: string) {
  const workbook = await unzipped(path, "xl/workbook.xml")
  if (!workbook) throw new Error("This workbook could not be read")
  const rels = await unzipped(path, "xl/_rels/workbook.xml.rels")
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]))
  const shared = [...(await unzipped(path, "xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]!))
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => ({
    name: unxml(m[0].match(/name="([^"]*)"/)?.[1] ?? "Sheet"),
    target: (targets.get(m[0].match(/r:id="([^"]+)"/)?.[1]) ?? "").replace(/^\/?(xl\/)?/, "xl/"),
  }))
  const parts: string[] = []
  for (const [n, sheet] of sheets.entries()) {
    const xml = sheet.target ? await unzipped(path, sheet.target) : ""
    const rows: { r: number; cells: Map<number, string> }[] = []
    let width = 0
    let isCut = false
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) {
        isCut = true
        break
      }
      const cells = new Map<number, string>()
      for (const c of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!
        const col = columnOf(attrs.match(/r="([A-Z]+)/)?.[1] ?? letters(cells.size))
        if (col >= MAX_COLS) {
          isCut = true
          continue
        }
        const body = c[2] ?? ""
        const type = attrs.match(/t="(\w+)"/)?.[1]
        const v = unxml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "")
        const value = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? texts(body) : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : v
        if (value === "") continue // formatting only
        cells.set(col, value)
        width = Math.max(width, col + 1)
      }
      rows.push({ r: Number(row[1]!.match(/r="(\d+)"/)?.[1] ?? rows.length + 1), cells })
    }
    const head = `<tr><th></th>${Array.from({ length: width }, (_, i) => `<th>${letters(i)}</th>`).join("")}</tr>`
    const body = rows
      .filter(r => r.cells.size)
      .map(r => `<tr><th>${r.r}</th>${Array.from({ length: width }, (_, i) => `<td>${escape(r.cells.get(i) ?? "")}</td>`).join("")}</tr>`)
      .join("")
    parts.push(`<section id="s${n}"><h2>${escape(sheet.name)}</h2>${body ? `<table>${head}${body}</table>` : "<p class=empty>Empty sheet</p>"}${isCut ? `<p class=cut>Only the first ${MAX_ROWS} rows and ${MAX_COLS} columns show here.</p>` : ""}</section>`)
  }
  const index = sheets.length > 1 ? `<nav>${sheets.map((s, n) => `<a href="#s${n}">${escape(s.name)}</a>`).join("")}</nav>` : ""
  return `<style>
  .page { margin: 0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; color: #1d1d1f; background: #fff; }
  nav { position: sticky; top: 0; z-index: 2; display: flex; gap: 4px; padding: 8px 12px; background: #f5f5f7; border-bottom: 1px solid #ddd; }
  nav a { padding: 3px 10px; border-radius: 6px; color: #1d1d1f; text-decoration: none; background: #fff; border: 1px solid #ddd; }
  section { padding: 12px; } h2 { font-size: 14px; margin: 4px 0 10px; }
  table { border-collapse: collapse; } th, td { border: 1px solid #e3e3e6; padding: 4px 8px; vertical-align: top; text-align: left; }
  th { background: #f5f5f7; color: #6e6e73; font-weight: 500; font-size: 11.5px; position: sticky; top: 0; }
  tr th:first-child { position: sticky; left: 0; text-align: right; }
  td { white-space: pre-wrap; max-width: 520px; }
  .empty, .cut { color: #6e6e73; }
</style><div class="page">${index}${parts.join("")}</div>`
}

// The picture Quick Look makes of a file, kept while the file is unchanged.
export async function quickLook(path: string) {
  const info = await stat(path)
  const dir = join(tmpdir(), "agent-center-previews", Bun.hash(`${path}:${info.mtimeMs}`).toString(36))
  const png = join(dir, `${basename(path)}.png`)
  if (!(await Bun.file(png).exists())) {
    await mkdir(dir, { recursive: true })
    await exec(["/usr/bin/qlmanage", "-t", "-s", "1600", "-o", dir, path], { timeoutMs: 20_000 })
  }
  const file = Bun.file(png)
  if (!(await file.exists())) throw new Error("macOS has no preview for this file")
  return file
}

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Documentation always uses `/`, so every path this test reads or compares is normalized to it. */
const posix = (path: string): string => path.split(sep).join('/')
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/
/** Links may also reach a two-digit working note such as `00-phase1-...md`; compare their numbers numerically. */
const LINKED = /^(\d{2,3})-[a-z0-9-]+\.md$/
const numbered = readdirSync(join(ROOT, 'docs')).filter(name => NUMBERED.test(name)).sort()
const entries = ['README.md', 'SETUP.md']
const documents = [...entries, ...readdirSync(join(ROOT, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)]
/** Line endings are normalized so headings and table rows match the same way on every checkout. */
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')
function links(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => posix(relative(ROOT, join(entry.parentPath, entry.name))))
/**
 * Extract repo-relative file paths from the first column of a table under `## <heading>` in `docs/007-architecture.md`.
 * Bare filenames inherit the directory of the preceding path in the same cell. The headings are Chinese, so the
 * constants passed in are the literal section titles (`模块`, `测试`).
 */
function listed(heading: string): string[] {
  const lines = read('docs/007-architecture.md').split('\n')
  const start = lines.indexOf(`## ${heading}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two rows are the header and its separator.
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return posix(join(directory, name!))
      directory = dirname(name!)
      return name!
    })
  })
}

describe('documentation', () => {
  it('numbers documents consecutively from 000', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('links numbered documents only to earlier numbered documents', () => {
    const violations = numbered.flatMap(name => links(join(ROOT, 'docs', name)).flatMap(target => {
      const linked = resolve(ROOT, 'docs', target)
      if (!linked.endsWith('.md')) return []
      const number = LINKED.exec(basename(linked))?.[1]
      return dirname(linked) === join(ROOT, 'docs') && number !== undefined && Number(number) < Number(name.slice(0, 3)) ? [] : [`${name} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('resolves every local link', () => {
    const files = [...entries.map(name => join(ROOT, name)), ...numbered.map(name => join(ROOT, 'docs', name))]
    const missing = files.flatMap(file => links(file).filter(target => !existsSync(resolve(dirname(file), target))).map(target => `${file.slice(ROOT.length + 1)} → ${target}`))
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(documents.filter(path => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
  it('lists every module of src in the module table of 007 Architecture, and only files that exist', () => {
    const modules = listed('模块')
    expect(files('src').filter(path => !modules.includes(path))).toEqual([])
    expect(modules.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('lists every test in the test table of 007 Architecture, and only files that exist', () => {
    const tests = listed('测试')
    expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path))).toEqual([])
    expect(tests.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
})

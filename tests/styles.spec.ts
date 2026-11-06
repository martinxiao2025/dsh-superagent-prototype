import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const dir = join(process.cwd(), 'src/client')
const css = readFileSync(join(dir, 'client.css'), 'utf8')
const code = readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')

it('styles only classes a component uses', () => {
  // 形如 `dt-btn-${variant}` 的模板字面量匹配所有以该前缀开头的类名。
  const prefixes = [...code.matchAll(/(dt-[\w-]*-)\$\{/g)].map(match => match[1]!)
  const used = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(code) || prefixes.some(prefix => name.startsWith(prefix))
  const classes = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(dt-[\w-]+)/g)].map(match => match[1]!))
  expect([...classes].filter(name => !used(name))).toEqual([])
})

it('writes one rule per line, each selector once within its block', () => {
  const blocks: string[][] = [[]]
  for (const line of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(text => text.trim()).filter(Boolean)) {
    if (line === '}') { blocks.pop(); continue }
    if (/^@(media|container|supports)\b.*\{$/.test(line)) { blocks.push([]); continue }
    // 一条规则，或带步骤的 keyframes 规则，都在同一行内开始并结束。
    expect(line).toMatch(/^[^{}]+\{[^{}]*\}$|^@keyframes [\w-]+ \{( [^{}]+ \{[^{}]*\})+ \}$/)
    if (line.startsWith('@')) continue
    const selector = line.slice(0, line.indexOf('{')).trim()
    expect(blocks.at(-1)).not.toContain(selector)
    blocks.at(-1)!.push(selector)
  }
})

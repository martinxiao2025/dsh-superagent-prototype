#!/usr/bin/env node
/**
 * 从 `plugin/`（唯一事实源）与随包技能组装 agent-plugins 包到 `lib/plugin`。
 * `tsdown` 必须先运行：它的第一份配置会清空 `lib/`。
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'plugin')
const SKILLS = join(ROOT, 'skills')
const OUT = join(ROOT, 'lib', 'plugin')
const TEXT = /\.(json|md|txt|ya?ml)$/i
const BUNDLED_SKILLS = ['dsh-superagent-github', 'dsh-superagent-feishu']

const fail = message => {
  console.error(`build-plugin: ${message}`)
  process.exit(1)
}
/** 以 UTF-8 读取文本文件；遇到 BOM 直接拒绝，因为插件携带的每个文件都必须是纯 UTF-8。 */
const read = path => {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${relative(ROOT, path)} 以 BOM 开头，请保存为无 BOM 的 UTF-8`)
  }
  return bytes.toString('utf8')
}
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text.replace(/\r\n/g, '\n'), 'utf8')
}
/** 复制文件，并把文本文件规范为无 BOM 的 UTF-8 与 LF 换行。 */
const copy = (from, to) => {
  if (!statSync(from).isFile()) fail(`${relative(ROOT, from)} 不是文件`)
  if (TEXT.test(from)) write(to, read(from))
  else { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to) }
}
/** 递归复制整棵目录树。 */
const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const source = join(from, name), target = join(to, name)
    if (statSync(source).isDirectory()) copyTree(source, target)
    else copy(source, target)
  }
}
const isDirectory = path => {
  try { return statSync(path).isDirectory() } catch { return false }
}

rmSync(OUT, { recursive: true, force: true })

const pkg = JSON.parse(read(join(ROOT, 'package.json')))
const manifest = JSON.parse(read(join(SOURCE, 'plugin.json')))
manifest.version = pkg.version
write(join(OUT, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copy(join(SOURCE, 'mcp.json'), join(OUT, 'mcp.json'))

const skillSources = []
const pluginSkills = join(SOURCE, 'skills')
if (isDirectory(pluginSkills)) {
  for (const name of readdirSync(pluginSkills)) {
    if (!isDirectory(join(pluginSkills, name))) fail(`plugin/skills/${name} 不是目录；技能必须放在直接子目录里`)
    skillSources.push({ name, from: join(pluginSkills, name) })
  }
}
for (const name of BUNDLED_SKILLS) {
  const from = join(SKILLS, name)
  if (!isDirectory(from)) fail(`skills/${name} 缺失，但插件需要随包携带它`)
  if (skillSources.some(skill => skill.name === name)) continue
  skillSources.push({ name, from })
}
for (const skill of skillSources) copyTree(skill.from, join(OUT, 'skills', skill.name))

const tree = directory => readdirSync(directory).sort().flatMap(name => {
  const path = join(directory, name)
  return statSync(path).isDirectory()
    ? [`${name}/`, ...tree(path).map(line => `  ${line}`)]
    : [name]
})
console.log(`build-plugin: 已写入 ${relative(ROOT, OUT)}`)
for (const line of tree(OUT)) console.log(`  ${line}`)
console.log(`build-plugin: ${skillSources.length} 个技能，版本 ${manifest.version}`)

#!/usr/bin/env node
/**
 * Assembles the agent-plugins package into `lib/plugin` from `plugin/` (the source of truth) and the bundled skills.
 * `tsdown` must run first: its first configuration cleans `lib/`.
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
/** Reads a text file as UTF-8, refusing a BOM, as every file the plugin ships must be plain UTF-8. */
const read = path => {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${relative(ROOT, path)} starts with a BOM; save it as UTF-8 without BOM`)
  }
  return bytes.toString('utf8')
}
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text.replace(/\r\n/g, '\n'), 'utf8')
}
/** Copies a file, normalizing text files to UTF-8 without BOM and LF. */
const copy = (from, to) => {
  if (!statSync(from).isFile()) fail(`${relative(ROOT, from)} is not a file`)
  if (TEXT.test(from)) write(to, read(from))
  else { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to) }
}
/** Copies a directory tree recursively. */
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
    if (!isDirectory(join(pluginSkills, name))) fail(`plugin/skills/${name} is not a directory; skills live in direct subdirectories`)
    skillSources.push({ name, from: join(pluginSkills, name) })
  }
}
for (const name of BUNDLED_SKILLS) {
  const from = join(SKILLS, name)
  if (!isDirectory(from)) fail(`skills/${name} is missing; the plugin bundles it`)
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
console.log(`build-plugin: wrote ${relative(ROOT, OUT)}`)
for (const line of tree(OUT)) console.log(`  ${line}`)
console.log(`build-plugin: ${skillSources.length} skill(s), version ${manifest.version}`)

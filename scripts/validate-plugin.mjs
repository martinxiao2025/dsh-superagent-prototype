#!/usr/bin/env node
/**
 * Validates an agent-plugins package offline: the two manifests against the vendored 1.0.0 schemas, their versions, the
 * loopback MCP URL, the skills layout, and UTF-8 without BOM. Exits 1 with the failing file and reason.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMAS = join(ROOT, 'scripts', 'schemas', 'agent-plugins-1.0.0')
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const TEXT = /\.(json|md|txt|ya?ml)$/i
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION = /\/schemas\/(\d+\.\d+\.\d+)\//

const args = process.argv.slice(2)
const at = args.indexOf('--dir')
const directory = resolve(ROOT, at >= 0 ? args[at + 1] ?? '' : 'plugin')
const errors = []
const fail = message => errors.push(message)
const show = path => relative(ROOT, path)

if (at >= 0 && !args[at + 1]) {
  console.error('validate-plugin: --dir needs a path')
  process.exit(1)
}
if (!existsSync(directory) || !statSync(directory).isDirectory()) {
  console.error(`validate-plugin: ${show(directory)} is not a directory`)
  process.exit(1)
}
/** Reads a file as UTF-8 without BOM, or records why it cannot. */
const read = path => {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${show(path)}: starts with a BOM; save it as UTF-8 without BOM`)
    return undefined
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail(`${show(path)}: is not valid UTF-8`); return undefined }
}
const readJson = path => {
  const text = read(path)
  if (text === undefined) return undefined
  try { return JSON.parse(text) }
  catch (error) { fail(`${show(path)}: is not JSON (${error.message})`); return undefined }
}
const schemaVersion = (value, path) => {
  const match = VERSION.exec(typeof value === 'string' ? value : '')
  if (!match) fail(`${show(path)}: $schema is not one of the 1.0.0 schema URLs`)
  return match?.[1]
}
const ajv = new Ajv2020({ allErrors: true, strict: false })
const check = (schemaFile, document, path) => {
  const schema = JSON.parse(readFileSync(join(SCHEMAS, schemaFile), 'utf8'))
  const validate = ajv.compile(schema)
  if (!validate(document)) {
    for (const issue of validate.errors ?? []) {
      fail(`${show(path)}: ${issue.instancePath || '/'} ${issue.message ?? 'is invalid'}`)
    }
  }
}

const pluginPath = join(directory, 'plugin.json')
const mcpPath = join(directory, 'mcp.json')
const plugin = existsSync(pluginPath) ? readJson(pluginPath) : (fail(`${show(pluginPath)}: is missing`), undefined)
const mcp = existsSync(mcpPath) ? readJson(mcpPath) : (fail(`${show(mcpPath)}: is missing`), undefined)

if (plugin && typeof plugin === 'object') check('plugin.schema.json', plugin, pluginPath)
if (mcp && typeof mcp === 'object') check('mcp.schema.json', mcp, mcpPath)

const pluginVersion = plugin ? schemaVersion(plugin.$schema, pluginPath) : undefined
if (pluginVersion !== '1.0.0') fail(`${show(pluginPath)}: must use the 1.0.0 plugin schema`)
if (mcp) {
  const mcpVersion = schemaVersion(mcp.$schema, mcpPath)
  if (mcpVersion !== pluginVersion) fail(`${show(mcpPath)}: $schema version ${mcpVersion ?? '?'} differs from plugin.json's ${pluginVersion ?? '?'}`)
}

const pkg = readJson(join(ROOT, 'package.json'))
if (plugin && pkg && plugin.version !== pkg.version) {
  fail(`${show(pluginPath)}: version ${plugin.version ?? '(none)'} differs from package.json's ${pkg.version}`)
}

if (mcp) {
  const servers = mcp.mcpServers
  if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) fail(`${show(mcpPath)}: mcpServers is empty`)
  for (const [name, server] of Object.entries(servers ?? {})) {
    const url = server && typeof server === 'object' ? server.url : undefined
    if (typeof url !== 'string') continue
    let parsed
    try { parsed = new URL(url) }
    catch { fail(`${show(mcpPath)}: mcpServers.${name}.url is not a URL`); continue }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      fail(`${show(mcpPath)}: mcpServers.${name}.url must point at loopback, not ${parsed.hostname}`)
    }
    if (parsed.protocol !== 'http:') fail(`${show(mcpPath)}: mcpServers.${name}.url must use http on loopback`)
    if (parsed.pathname !== '/mcp') fail(`${show(mcpPath)}: mcpServers.${name}.url must end at /mcp, not ${parsed.pathname}`)
  }
}

/** Checks one `skills/<name>/SKILL.md`: direct subdirectory, frontmatter with single-line name and description, name matches. */
const skill = (skills, name) => {
  const path = join(skills, name)
  if (!statSync(path).isDirectory()) {
    fail(`${show(path)}: skills must be direct subdirectories; files are not loaded`)
    return
  }
  if (!NAME.test(name)) fail(`${show(path)}: skill directory names are lowercase kebab-case`)
  const file = join(path, 'SKILL.md')
  if (!existsSync(file)) { fail(`${show(file)}: is missing`); return }
  const text = read(file)
  if (text === undefined) return
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!frontmatter) { fail(`${show(file)}: needs a --- frontmatter block`); return }
  const block = frontmatter[1]
  const field = key => new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'm').exec(block)?.[1]?.trim()
  const declared = field('name'), description = field('description')
  if (!declared) fail(`${show(file)}: frontmatter needs a single-line name`)
  else if (declared !== name) fail(`${show(file)}: frontmatter name ${declared} differs from its directory ${name}`)
  if (!description) fail(`${show(file)}: frontmatter needs a single-line description`)
}

const skills = join(directory, 'skills')
if (existsSync(skills)) for (const name of readdirSync(skills)) skill(skills, name)

/** Rejects a BOM or invalid UTF-8 in any text file the package ships. */
const walk = path => {
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    if (statSync(child).isDirectory()) walk(child)
    else if (TEXT.test(name)) read(child)
  }
}
walk(directory)

if (errors.length) {
  console.error(`validate-plugin: ${show(directory)} failed with ${errors.length} problem(s)`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}
const servers = Object.keys(mcp?.mcpServers ?? {}).length
const skillsCount = existsSync(skills) ? readdirSync(skills).length : 0
console.log(`validate-plugin: ${show(directory)} is valid (${servers} MCP server(s), ${skillsCount} skill(s), version ${plugin.version})`)

#!/usr/bin/env node
/**
 * 离线校验 agent-plugins 包：两份清单对照随仓库携带的 1.0.0 schema、版本、回环 MCP URL、
 * 技能目录结构，以及无 BOM 的 UTF-8。失败时退出码 1，并打印出错文件与原因。
 * 这是作者侧门禁，比规范对客户端的最低行为更严格（未知顶层字段、空 `mcpServers`、非回环 URL
 * 都直接失败），因此通过本脚本不等于通过客户端一致性验证。
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
  console.error('validate-plugin: --dir 需要一个路径')
  process.exit(1)
}
if (!existsSync(directory) || !statSync(directory).isDirectory()) {
  console.error(`validate-plugin: ${show(directory)} 不是目录`)
  process.exit(1)
}
/** 以 UTF-8 无 BOM 读取文件；失败时记录原因。 */
const read = path => {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${show(path)}: 以 BOM 开头，请保存为无 BOM 的 UTF-8`)
    return undefined
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail(`${show(path)}: 不是合法的 UTF-8`); return undefined }
}
const readJson = path => {
  const text = read(path)
  if (text === undefined) return undefined
  try { return JSON.parse(text) }
  catch (error) { fail(`${show(path)}: 不是合法的 JSON（${error.message}）`); return undefined }
}
const schemaVersion = (value, path) => {
  const match = VERSION.exec(typeof value === 'string' ? value : '')
  if (!match) fail(`${show(path)}: $schema 不是 1.0.0 的 schema URL`)
  return match?.[1]
}
const ajv = new Ajv2020({ allErrors: true, strict: false })
const check = (schemaFile, document, path) => {
  const schema = JSON.parse(readFileSync(join(SCHEMAS, schemaFile), 'utf8'))
  const validate = ajv.compile(schema)
  if (!validate(document)) {
    for (const issue of validate.errors ?? []) {
      fail(`${show(path)}: ${issue.instancePath || '/'} ${issue.message ?? '不合法'}`)
    }
  }
}

const pluginPath = join(directory, 'plugin.json')
const mcpPath = join(directory, 'mcp.json')
const plugin = existsSync(pluginPath) ? readJson(pluginPath) : (fail(`${show(pluginPath)}: 文件缺失`), undefined)
const mcp = existsSync(mcpPath) ? readJson(mcpPath) : (fail(`${show(mcpPath)}: 文件缺失`), undefined)

if (plugin && typeof plugin === 'object') check('plugin.schema.json', plugin, pluginPath)
if (mcp && typeof mcp === 'object') check('mcp.schema.json', mcp, mcpPath)

const pluginVersion = plugin ? schemaVersion(plugin.$schema, pluginPath) : undefined
if (pluginVersion !== '1.0.0') fail(`${show(pluginPath)}: 必须使用 1.0.0 的 plugin schema`)
if (mcp) {
  const mcpVersion = schemaVersion(mcp.$schema, mcpPath)
  if (mcpVersion !== pluginVersion) fail(`${show(mcpPath)}: $schema 版本 ${mcpVersion ?? '?'} 与 plugin.json 的 ${pluginVersion ?? '?'} 不一致`)
}

const pkg = readJson(join(ROOT, 'package.json'))
if (plugin && pkg && plugin.version !== pkg.version) {
  fail(`${show(pluginPath)}: 版本 ${plugin.version ?? '（缺失）'} 与 package.json 的 ${pkg.version} 不一致`)
}

if (mcp) {
  const servers = mcp.mcpServers
  if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) fail(`${show(mcpPath)}: mcpServers 为空`)
  for (const [name, server] of Object.entries(servers ?? {})) {
    const url = server && typeof server === 'object' ? server.url : undefined
    if (typeof url !== 'string') continue
    let parsed
    try { parsed = new URL(url) }
    catch { fail(`${show(mcpPath)}: mcpServers.${name}.url 不是合法的 URL`); continue }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      fail(`${show(mcpPath)}: mcpServers.${name}.url 必须指向回环地址，而不是 ${parsed.hostname}`)
    }
    if (parsed.protocol !== 'http:') fail(`${show(mcpPath)}: mcpServers.${name}.url 在回环上必须使用 http`)
    if (parsed.pathname !== '/mcp') fail(`${show(mcpPath)}: mcpServers.${name}.url 必须以 /mcp 结尾，而不是 ${parsed.pathname}`)
  }
}

/** 校验单个 `skills/<name>/SKILL.md`：必须是直接子目录，frontmatter 含单行 name 与 description，且 name 与目录同名。 */
const skill = (skills, name) => {
  const path = join(skills, name)
  if (!statSync(path).isDirectory()) {
    fail(`${show(path)}: 技能必须是直接子目录，散落的文件不会被加载`)
    return
  }
  if (!NAME.test(name)) fail(`${show(path)}: 技能目录名必须是小写 kebab-case`)
  const file = join(path, 'SKILL.md')
  if (!existsSync(file)) { fail(`${show(file)}: 文件缺失`); return }
  const text = read(file)
  if (text === undefined) return
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!frontmatter) { fail(`${show(file)}: 需要 --- frontmatter 块`); return }
  const block = frontmatter[1]
  const field = key => new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'm').exec(block)?.[1]?.trim()
  const declared = field('name'), description = field('description')
  if (!declared) fail(`${show(file)}: frontmatter 需要单行 name`)
  else if (declared !== name) fail(`${show(file)}: frontmatter 的 name ${declared} 与目录名 ${name} 不一致`)
  if (!description) fail(`${show(file)}: frontmatter 需要单行 description`)
}

const skills = join(directory, 'skills')
if (existsSync(skills)) for (const name of readdirSync(skills)) skill(skills, name)

/** 拒绝包内任何文本文件的 BOM 或非法 UTF-8。 */
const walk = path => {
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    if (statSync(child).isDirectory()) walk(child)
    else if (TEXT.test(name)) read(child)
  }
}
walk(directory)

if (errors.length) {
  console.error(`validate-plugin: ${show(directory)} 有 ${errors.length} 个问题`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}
const servers = Object.keys(mcp?.mcpServers ?? {}).length
const skillsCount = existsSync(skills) ? readdirSync(skills).length : 0
console.log(`validate-plugin: ${show(directory)} 校验通过（${servers} 个 MCP 服务、${skillsCount} 个技能、版本 ${plugin.version}）`)

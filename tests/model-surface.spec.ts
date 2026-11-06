/**
 * 模型表面契约测试：对照工具 schema、环境变量、术语规则（`docs/001`）与体积预算，校验
 * orchestrator 与 worker 角色注册的工具、system prompt、skill 与 session 输入。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { latestAssignment } from '../src/core/index.ts'
import { promptParts } from '../src/app/prompts.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { TICKET_STATES } from '../src/app/cards.ts'
import { Runtime } from '../src/app/runtime.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { inputMessage } from '../src/executor/dsh.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { IM_WORDS, NOTE_WORDS, checkedImText } from '../src/infra/text.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { testMachine } from './fixtures/deployment.ts'

type Role = 'orchestrator' | 'worker'
interface Surface { where: string; owner: string; role: Role | 'both'; text: string }
interface Tool {
  name: string; description: string; parameters: unknown
  execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
}
type Section = (context: { signal?: AbortSignal }) => string
interface Skill { name: string; description: string; content: string }

/**
 * 每个角色的 system prompt 与工具定义合计字符数上限（约为基线的 105%）。
 * 缩小模型可见文本时调低该上限；调高时须有意为之，并在提交信息中说明原因。
 */
const BUDGET: Record<Role, number> = { orchestrator: 59_000, worker: 40_500 }
const PROMPTS = 'prompts/, skills/', TOOLS = 'src/app/tools/', SESSIONS = 'src/app/sessions.ts'
const NOTICES = 'src/app/notices.ts', LINKS = 'src/app/links.ts', ASSESSMENT = 'src/app/assessment.ts'
const EXECUTOR = 'src/executor/dsh.ts', ERRORS = 'src/core/errors.ts'
const TICKETS = 'src/core/tickets.ts', ASSIGNMENTS = 'src/core/assignments.ts'
/** 由 `orchestrator_read` 的 resource 模板编译出的正则模式（`<…>` 匹配一段路径；`…` 匹配其余部分）。 */
const RESOURCE_NAMES = RESOURCES.map(({ name }) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^/\\s]+').replace('…', '.+')}$`))
/** report 与 assignment 的状态，文本中即以此称呼；ticket 或 worker 则处于某个 card 状态（TICKET_STATES）。 */
const REPORT_WORDS = /^(ready|waiting|blocked|failed|progress|running|queued)$/
/** 已被 `docs/001` 取代的弃用术语。 */
const LEGACY: [word: string, pattern: RegExp][] = [['reopen', /reopen/i], ['event/', /(?<![\w-])event\//], ['task/', /(?<![\w-])task\//],
  ['member', /\bmembers?\b/i], ['topic', /\btopics?\b/i], ['admission_', /\badmission_/], ['guide/', /\bguide\//]]
/** 生成的或静态的模型可见文本中禁止出现的短语。 */
const BANNED: [rule: string, where: RegExp, phrase: RegExp][] = [
  ['An out-of-scope proactive ticket ends as dropped', /^worker (prompt from the runtime|input assignment \(inferred\))$/, /report blocked/i],
  ['A question goes back where the person who raised it wrote', /./, /always returns to the original|ask(?: promptly)? in the original ticket conversation/i],
  ['The main Session has no tool that messages a worker', /./, /request the answer through the worker/i],
  ['A stop goes through orchestrator_route, not through an assessment', /^assessment instructions$/, /decision=stop/i],
]
/** 目前容忍的已知失败，按拥有该文本的文件归类；保持为空。 */
const KNOWN_FAILURES: [owner: string, failure: string][] = []

const MEMBER = 'ou_alice', CHAT = 'oc_team'
const feishu = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT,
  chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, mentions: [{ id: 'ou_bot' }],
  create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id) * 1000), ...overrides }, 'ou_bot', 'cli_bot')!
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/)
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

/** 在假冒的 DSH 主机上启动已配置的 Runtime（同 tests/runtime.spec.ts），按 session 记录注册的工具、prompt、skill 与已投递消息。 */
async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'model-surface-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const answers: Record<string, string> = {
    [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
    [`git -C ${directory} remote get-url --push origin`]: 'https://github.com/acme/widgets.git\n',
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']:
      `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const subprocess = { spawn: (spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const collected = { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') }
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected }
  } }
  const agents = new Map<string, { status: string }>()
  const tools = new Map<string, Map<string, Tool>>()
  const sections = new Map<string, Section>()
  const skills = new Map<string, Skill[]>()
  const inputs: { sessionId: string; text: string }[] = []
  const create = async ({ sessionId }: { sessionId: string }) => {
    if (agents.has(sessionId)) return
    const agentCtx = new Context()
    const own = new Map<string, Tool>(), registered: Skill[] = []
    tools.set(sessionId, own); skills.set(sessionId, registered)
    const register = (tool: Tool) => { own.set(tool.name, tool); return () => own.delete(tool.name) }
    agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
    agentCtx.reflect.provide('skills', { register: (skill: Skill) => { registered.push(skill); return () => {} } })
    const section = (spec: { text: Section }) => { sections.set(sessionId, spec.text); return () => {} }
    agentCtx.reflect.provide('systemPrompt', { section })
    const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
      // 取出一条待处理消息，如同 DSH 的 inbox 按 id 取出那样。
      remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
        const at = list.findIndex(message => message.id === id)
        if (at >= 0) list.splice(at, 1)
        return at >= 0
      }) }
    const record = (message: UserMessage) => {
      inputs.push({ sessionId, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
    }
    const deliver = (queue: UserMessage[]) => (message: UserMessage) => {
      queue.push(message); record(message); agents.get(sessionId)!.status = 'running'
    }
    const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: () => {} }
    agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver(inbox.nextTurn), steer: deliver(inbox.nextStep),
      inject: record, status: 'idle', cancel: () => {}, whenIdle: async () => {}, session } as never)
  }
  const resolveAgent = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const ctx = new Context()
  const history = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const services = { agents, llm: { resolveCallConfig: async (value: unknown) => value },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
    sessionController: { create, resolveAgent, selectModel: async () => {}, rename: async () => {}, inspect: async () => ({ events: [] }) },
    sessionPersistence: { flush: async () => {}, open: async () => history }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} } }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const seed = new Store(join(directory, 'orchestrator.sqlite'))
  const github = { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }
  seed.saveSettings(SettingsSchema.parse({ ...seed.settings(), sources: { github, feishu: { enabled: true, config: { cli: BOT } } } }))
  seed.close()
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory }), () => {})
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  const allowed = { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } }
  const feishuSource = { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } }
  runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: allowed }, eval: { ...settings.eval, mode: 'auto' },
    sources: { ...settings.sources, feishu: feishuSource } })
  const run = async (sessionId: string, name: string, args: unknown) =>
    await tools.get(sessionId)!.get(name)!.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  const stop = async () => { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  return { ctx, runtime, agents, tools, sections, skills, inputs, run, stop }
}
type Host = Awaited<ReturnType<typeof start>>

/** 跑通 orchestrator 与 worker 的流程，使 runtime 生成的全部 prompt 部分、card、notice 与 error 都被输出。 */
async function drive(host: Host) {
  const { runtime, run } = host
  const master = runtime.masterId
  // Candidates 会等待，由主 Session 在一次调用中决定：它接受一个请求、致谢并忽略它，以及频道里的普通聊天，
  // 还有一个 card 显示它不涉及任何规则的主动候选，它从 card 上忽略该候选。
  const request = feishu('1', '@bot 修一下回归'), thanks = feishu('3', '@bot 谢谢'), chat = feishu('4', '中午吃什么', { mentions: [] })
  await runtime.receive(request); await runtime.receive(thanks); await runtime.receive(chat)
  const routed = await run(master, 'orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: request.id, title: '修复回归', worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' }, { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' }] }) as
    { results: { decision?: string; reason?: string; ticket?: { ticket_id: string } }[] }
  expect(routed.results.map(result => result.decision)).toEqual(['accept', 'ignore', 'ignore'])
  expect(routed.results[2]!.reason).toMatch(/^Ignored from its card/)
  const a = routed.results[0]!.ticket!.ticket_id
  const answer = { trigger_id: request.id, purpose: 'answer', text: '是配置。' }
  const refusal = await run(master, 'orchestrator_reply', answer).then(() => '', (error: Error) => error.message)
  const proposal = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await runtime.receive(proposal)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_5', chat_id: CHAT }] })
  await run(master, 'orchestrator_eval', { trigger_id: proposal.id })
  const proactive = (await run(master, 'orchestrator_eval_decide', { trigger_id: proposal.id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix',
    scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'it names the text' } })).ticket as { ticket_id: string }
  const b = proactive.ticket_id
  await runtime.idle()
  const [workerA, workerB] = [a, b].map(workerSessionId) as [string, string]
  await run(workerA, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await run(workerA, 'orchestrator_report', { state: 'progress', summary: 'It reads the config.', human_action: null, reply_to_trigger_id: request.id })
  const other = feishu('9', '@bot 顺便看看这个')
  await runtime.receive(other)
  await run(master, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: a, trigger_id: other.id }] })
  await run(workerA, 'orchestrator_thread_unrelated', { thread: `feishu:${CHAT}:om_9`, reason: 'It asks for something else.' })
  await run(workerA, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_7`, reason: 'The same settings page.' })
  await runtime.receive(feishu('7', '@bot 这个页面的按钮也改一下'))
  const beyond = feishu('8', '另外把导出也做了', { mentions: [], root_id: 'om_1' })
  await runtime.receive(beyond)
  await runtime.idle()
  await run(workerA, 'orchestrator_trigger_handback', { trigger_id: beyond.id, reason: 'It asks for an export feature.' })
  await run(master, 'orchestrator_ticket_note', { ticket_id: a, text: 'Ticket B changes the same settings page.' })
  await runtime.pump()
  await runtime.idle()
  await run(workerA, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  await runtime.receive(feishu('2', '再加一个按钮', { mentions: [], root_id: 'om_1' }))
  await vi.waitFor(async () => {
    await runtime.pump()
    expect(runtime.store.tickets.get(a)!.inputs.some(input => input.kind === 'resumed')).toBe(true)
  })
  const policy = runtime.store.settings().policy
  // ticket b 接受时适用的规则发生变化，因此会告知其 worker 具体变化；它不适用的那条规则被禁用，不会告知任何人。
  const rules = policy.rules.map(rule => rule.id === 'visual' ? { ...rule, enabled: false }
    : rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep the wording short.` } : rule)
  await runtime.settings.save('policy', { ...policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  // Worker b 的 turn 结束：它进入空闲，正如 DSH 发出事件时所述。
  host.agents.get(workerB)!.status = 'idle'
  host.ctx.emit('agent/status', { agent: host.agents.get(workerB), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(runtime.store.tickets.get(b)!)?.report?.state).toBe('waiting'))
  runtime.engine.requestStatus(b)
  // 在状态请求到达 worker 之后才执行恢复（此时其 Assignment 处于忙碌而非已结算状态），因此它会收到 recovery 说明。
  await runtime.idle()
  expect(runtime.store.tickets.get(b)!.undelivered).toEqual([])
  runtime.executor.resume()
  await runtime.pump()
  await runtime.idle()
  return { a, b, workerA, workerB, refusal }
}

function walk(node: unknown, visit: (node: Record<string, unknown>, property?: string) => void, property?: string): void {
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, property); return }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  visit(record, property)
  for (const [name, value] of Object.entries(record)) {
    const properties = name === 'properties' && value && typeof value === 'object' ? Object.entries(value) : undefined
    if (properties) for (const [child, schema] of properties) walk(schema, visit, child)
    else walk(value, visit, ['anyOf', 'oneOf', 'allOf', 'items'].includes(name) ? property : undefined)
  }
}

/** 收集所有模型可见的文本表面（prompt 部分、工具 schema、skill、error 与 session 输入）及其所属模块。 */
function collect(host: Host, { a, b, workerA, workerB, refusal }: Awaited<ReturnType<typeof drive>>): Surface[] {
  const { runtime } = host
  const surfaces: Surface[] = []
  const config = runtime.prompts.current().config
  const shared = new Set(['runtime/shared', 'communication', 'scope', 'delivery', 'runtime/subscriptions', 'runtime/replies'])
  for (const [role, sessionId] of [['orchestrator', runtime.masterId], ['worker', workerA], ['worker', workerB]] as const) {
    const parts = promptParts(config, role)
    for (const { name, text } of parts) {
      surfaces.push({ where: `${role} prompt ${name}`, owner: PROMPTS, role: shared.has(name) ? 'both' : role, text })
    }
    // 修订行、执行环境以及主动 ticket 上的说明都来自 runtime。
    const generated = parts.reduce((text, part) => text.replace(part.text, ''), host.sections.get(sessionId)!({}))
    surfaces.push({ where: `${role} prompt from the runtime`, owner: SESSIONS, role, text: generated })
  }
  for (const [role, sessionId] of [['orchestrator', runtime.masterId], ['worker', workerA]] as const) {
    for (const tool of host.tools.get(sessionId)!.values()) {
      const descriptions = [tool.description]
      walk(tool.parameters, node => { if (typeof node.description === 'string') descriptions.push(node.description) })
      surfaces.push({ where: `${role} tool ${tool.name}`, owner: TOOLS, role, text: descriptions.join('\n') })
    }
  }
  for (const { name, description, content } of host.skills.get(runtime.masterId)!) {
    surfaces.push({ where: `skill ${name}`, owner: PROMPTS, role: 'both', text: `${description}\n${content}` })
  }
  surfaces.push({ where: 'orchestrator tool orchestrator_reply error', owner: ERRORS, role: 'orchestrator', text: refusal })
  for (const { text } of host.inputs.filter(input => input.sessionId === runtime.masterId)) {
    const value = JSON.parse(text) as Record<string, unknown>
    const kind = String(value.kind ?? Object.keys(value)[0])
    const owner = kind === 'candidate' ? LINKS : kind === 'worker_attention' ? TOOLS : kind === 'worker_report' ? EXECUTOR : NOTICES
    surfaces.push({ where: `orchestrator input ${kind}`, owner, role: 'orchestrator', text })
  }
  for (const [id, sessionId] of [[a, workerA], [b, workerB]] as const) {
    const ticket = runtime.store.tickets.get(id)!
    const assignment = ticket.execution!.assignment
    surfaces.push({ where: `worker input assignment (${ticket.mandate.strength})`, owner: EXECUTOR, role: 'worker', text: assignment })
    const card = (text: string) => { try { return JSON.parse(text) as Record<string, unknown> } catch { return undefined } }
    for (const { text } of host.inputs.filter(input => input.sessionId === sessionId)) {
      const input = ticket.inputs.find(item => item.kind === 'trigger' ? card(text)?.trigger_id === item.triggerId
        : inputMessage(item) === text)
      if (!input) continue
      // 文本输入以其 id 前缀命名；重启说明的 id 是内容哈希，因此以其文本命名。
      const kind = input.kind === 'trigger' ? input.context ? 'trigger (context)' : 'trigger' : input.kind !== 'text' ? input.kind
        : input.id.includes(':') ? input.id.split(':')[0]! : /host restarted/i.test(input.text) ? 'recovery' : 'text'
      const owner = kind === 'status' ? TICKETS : kind === 'recovery' ? ASSIGNMENTS : EXECUTOR
      surfaces.push({ where: `worker input ${kind}`, owner, role: 'worker', text })
    }
  }
  return surfaces
}

let host: Host
let sessions: Awaited<ReturnType<typeof drive>>
let surfaces: Surface[]
beforeAll(async () => {
  host = await start()
  sessions = await drive(host)
  surfaces = collect(host, sessions)
})
afterAll(async () => { await host?.stop() })
const toolsOf = (role: Role) => host.tools.get(role === 'orchestrator' ? host.runtime.masterId : sessions.workerA)!

/** 检查已收集的表面：未注册的工具、无效的枚举选项、遗留术语、禁止短语以及跨角色的工具引用。 */
function failures(): Map<string, string> {
  const found = new Map<string, string>()
  const options = new Map<string, Set<string>>()
  const schemas = [...toolsOf('orchestrator').values(), ...toolsOf('worker').values()].map(tool => tool.parameters)
  walk(schemas, (node, property) => {
    if (property && Array.isArray(node.enum)) options.set(property, new Set([...options.get(property) ?? [], ...node.enum.map(String)]))
  })
  for (const name of ['decision', 'purpose', 'state']) expect(options.has(name), `${name} has options`).toBe(true)
  const tools = { orchestrator: new Set(toolsOf('orchestrator').keys()), worker: new Set(toolsOf('worker').keys()) }
  const registered = (token: string) => tools.orchestrator.has(token) || tools.worker.has(token)
  const variables = new Set(host.runtime.ticketEnvironment(host.runtime.store.tickets.get(sessions.a)!).map(variable => variable.key))
  for (const { where, owner, role, text } of surfaces) {
    const fail = (problem: string) => found.set(`${where}: ${problem}`, owner)
    for (const [token] of text.matchAll(/\borchestrator_[a-z_]+/g)) if (!registered(token)) fail(`${token} is not a tool`)
    for (const [, name, values] of text.matchAll(/\b([a-z_]+)[=:] ?([a-z][a-z/-]*)/g)) {
      for (const value of options.has(name!) ? values!.split('/') : []) {
        if (!options.get(name!)!.has(value)) fail(`${name}=${value} is not an option`)
      }
    }
    for (const [word, pattern] of LEGACY) if (pattern.test(text)) fail(`legacy word "${word}"`)
    for (const [rule, scope, phrase] of BANNED) if (scope.test(where) && phrase.test(text)) fail(`breaks "${rule}"`)
    for (const [name] of text.matchAll(/\bDSH_SUPERAGENT_[A-Z][A-Z_]*[A-Z]\b/g)) if (!variables.has(name)) fail(`${name} is not a variable`)
    // ticket 或 worker 的状态是 card 状态；report 状态则用 report 一词指明。
    const states = [...text.matchAll(/\b([a-z]+(?:\/[a-z]+)*) (?:tickets?|workers?)\b/g), ...text.matchAll(/\b(?:tickets?|workers?) (?:is|are)(?: still)? ([a-z]+)\b/g)]
    for (const [phrase, word] of states) {
      if (word!.split('/').some(part => REPORT_WORDS.test(part)) && !(TICKET_STATES as readonly string[]).includes(word!)) fail(`"${phrase}" is not a card state`)
    }
    for (const [phrase] of text.matchAll(/\bwait(?:ing)? for (?:ready|waiting|blocked|failed)\b(?! report)/g)) fail(`"${phrase}" names a report state without report`)
    // 全角标点也会结束 resource 路径：中文行文写作 `trigger/<id>。`，中间没有空格。
    for (const [found] of text.matchAll(/\b(?:ticket|trigger|decision|prompts|prompt-preview|models|feishu|github)\/[^\s"'`,;)\]。，、：；！？（）【】“”‘’]*/g)) {
      const name = found.replace(/[.:]+$/, '')
      if (!RESOURCE_NAMES.some(pattern => pattern.test(name))) fail(`${name} is not a resource orchestrator_read reads`)
    }
    // 只有单一角色会读的文本，只有在说明另一角色会使用它们的句子里才会提到另一角色的工具。
    const other = role === 'orchestrator' ? 'worker' : role === 'worker' ? 'orchestrator' : undefined
    const names = other === 'worker' ? /\b(workers?|executors?)\b/i : /\b(orchestrator|main session)\b/i
    for (const sentence of sentences(text)) {
      for (const [, count] of sentence.matchAll(/\b(\d+)[- ]words?\b/g)) {
        const limit = /routing/i.test(sentence) ? NOTE_WORDS : IM_WORDS
        if (Number(count) !== limit) fail(`"${count} words" is not ${limit}`)
      }
      for (const [token] of other && !names.test(sentence) ? sentence.matchAll(/\borchestrator_[a-z_]+/g) : []) {
        if (!registered(token) || tools[role as Role].has(token)) continue
        fail(`tells the ${role} to use ${token}, which only the ${other} has`)
      }
    }
  }
  return found
}

it('collects both roles\' tools, prompts, skills and inputs', () => {
  expect([...toolsOf('worker').keys()].sort()).toEqual(['orchestrator_ack', 'orchestrator_read', 'orchestrator_report',
    'orchestrator_thread_follow',
    'orchestrator_thread_unrelated', 'orchestrator_trigger_handback'])
  expect([...toolsOf('orchestrator').keys()]).toEqual(expect.arrayContaining(['orchestrator_route', 'orchestrator_eval_decide', 'orchestrator_reply']))
  // 一个负责路由的工具替代了四个。
  for (const name of ['orchestrator_ticket_accept', 'orchestrator_ticket_attach', 'orchestrator_ticket_stop', 'orchestrator_trigger_ignore']) {
    expect(toolsOf('orchestrator').has(name)).toBe(false)
  }
  const wheres = new Set(surfaces.map(surface => surface.where))
  for (const where of ['orchestrator prompt runtime/dispatch', 'worker prompt runtime/work', 'skill dsh-superagent-github', 'skill dsh-superagent-feishu',
    'orchestrator prompt runtime/admission', 'orchestrator input candidate', 'orchestrator input worker_attention', 'orchestrator input worker_report',
    'orchestrator input thread_unrelated', 'orchestrator input ticket_ended', 'orchestrator input settings_saved', 'worker input assignment (explicit)',
    'worker input assignment (inferred)', 'worker input policy-changed', 'worker input resumed', 'worker input status',
    'worker input recovery', 'worker input note', 'worker input trigger (context)', 'orchestrator input follow_up',
    'orchestrator input thread_followed', 'orchestrator tool orchestrator_reply error']) expect(wheres).toContain(where)
  expect(sessions.refusal).not.toBe('')
})

it('names only registered tools, schema options, environment variables and glossary words, with the enforced word limits', () => {
  const found = failures(), known = new Map(KNOWN_FAILURES.map(([owner, failure]) => [failure, owner]))
  const drift = [...found].filter(([failure]) => !known.has(failure)).map(([failure, owner]) => `${owner}: ${failure}`)
  const fixed = [...known].filter(([failure]) => !found.has(failure))
    .map(([failure, owner]) => `${owner}: ${failure} (fixed: drop it from KNOWN_FAILURES)`)
  expect([...drift, ...fixed], 'model-facing text differs from KNOWN_FAILURES; each line starts with the owner of the text').toEqual([])
})

it('enforces the word limits the text states', async () => {
  expect(checkedImText(words(IM_WORDS))).toBe(words(IM_WORDS))
  expect(() => checkedImText(words(IM_WORDS + 1))).toThrow(`maximum is ${IM_WORDS}`)
  const attach = (note: string) =>
    host.run(host.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: 'unknown', trigger_id: 'unknown', note }] })
  // 超出限制的 note 只拒绝其自身条目；恰好等于限制的则继续交给 Engine，而 Engine 不认识该 ticket。
  expect(await attach(words(NOTE_WORDS + 1))).toEqual({ results: [expect.objectContaining({ refused: expect.stringContaining(`${NOTE_WORDS} words`) })] })
  expect(await attach(words(NOTE_WORDS))).toEqual({ results: [expect.objectContaining({ refused: expect.stringMatching(/Unknown (ticket|trigger)/) })] })
})

/** 主 Session 的 Policy 部分中已启用规则的各行，即当前 settings 所持有的那些。 */
const ruleLines = () => host.runtime.store.settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)
it.each(['orchestrator', 'worker'] as const)('keeps the %s within its character budget', role => {
  const ids = role === 'orchestrator' ? [host.runtime.masterId] : [sessions.workerA, sessions.workerB]
  // 测量 prompt 长度前，先去掉依赖机器的变量值（例如目录路径）以及团队的规则。
  const builtIn = (text: string) => ruleLines().reduce((rest, line) => rest.replace(line, ''), text).replace(/ = "[^"\n]*"/g, ' = ""')
  const prompt = Math.max(...ids.map(id => builtIn(host.sections.get(id)!({})).length))
  const definitions = [...toolsOf(role).values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  const tools = JSON.stringify(definitions).length
  expect(prompt + tools, `${prompt} characters of prompt and ${tools} of tools`).toBeLessThanOrEqual(BUDGET[role])
})

it('keeps the routing rules in dispatch, which says the main Session may accept the rest of a stop message as new work', () => {
  const route = toolsOf('orchestrator').get('orchestrator_route')!.description
  const dispatch = surfaces.find(surface => surface.where === 'orchestrator prompt runtime/dispatch')!.text
  expect(dispatch).toContain('you may accept the rest of the message as new work')
  expect(dispatch).toContain('decide those whose card already settles them in one orchestrator_route call')
  expect(route).not.toMatch(/needs a new ticket on another explicit instruction/)
})

it('lists in the main Session\'s Policy section exactly the enabled rules, as the drive\'s save left them', () => {
  const text = host.sections.get(host.runtime.masterId)!({}), at = text.indexOf('## Policy')
  const listed = text.slice(at, text.indexOf('\n\n', at)).split('\n').filter(line => line.startsWith('- '))
  expect(listed).toEqual(ruleLines())
  // 该 drive 禁用了视觉规则，并修改了文案规则的 instruction。
  expect(listed).toEqual([expect.stringMatching(/^- .* \(copy\): .*Keep the wording short\.$/)])
})

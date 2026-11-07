/**
 * 模型表面契约测试：对照工具 schema、环境变量、术语规则（`docs/001`）与体积预算，校验
 * orchestrator 与 worker 角色的 system prompt、工具、skill 与工单 assignment 文本。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { IM_WORDS, NOTE_WORDS, checkedImText } from '../src/infra/text.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { TICKET_STATES } from '../src/app/cards.ts'
import { composePrompt, environmentSection, promptParts } from '../src/app/prompts.ts'
import { toolJsonSchema } from '../src/executor/workspace-tools.ts'
import { bundledSkills } from '../src/app/skill-files.ts'
import type { Ticket } from '../src/core/index.ts'
import { CHAT, feishu, startRuntime, type Host as Fixture } from './fixtures/host.ts'

type Role = 'orchestrator' | 'worker'
interface Surface { where: string; owner: string; role: Role | 'both'; text: string }
interface Tool { name: string; description: string; parameters: unknown }
/** 每个角色的 system prompt、工具定义与 skill 合计字符数上限；缩小可见文本时调低，调高须有意为之。 */
const BUDGET: Record<Role, number> = { orchestrator: 60_000, worker: 41_000 }
const PROMPTS = 'prompts/, skills/', TOOLS = 'src/app/tools/', NOTICES = 'src/app/notices.ts'
const EXECUTOR = 'src/executor/messages.ts', ERRORS = 'src/core/errors.ts', ASSIGNMENTS = 'src/core/assignments.ts'
/** 由 `orchestrator_read` 的 resource 模板编译出的正则模式（`<…>` 匹配一段路径；`…` 匹配其余部分）。 */
const RESOURCE_NAMES = RESOURCES.map(({ name }) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^/\\s]+').replace('…', '.+')}$`))
/** report 与 assignment 的状态，文本中即以此称呼；ticket 或 worker 则处于某个 card 状态（TICKET_STATES）。 */
const REPORT_WORDS = /^(ready|waiting|blocked|failed|progress|running|queued)$/
/** 已被 `docs/001` 取代的弃用术语。 */
const LEGACY: [word: string, pattern: RegExp][] = [['reopen', /reopen/i], ['event/', /(?<![\w-])event\//], ['task/', /(?<![\w-])task\//],
  ['member', /\bmembers?\b/i], ['topic', /\btopics?\b/i], ['admission_', /\badmission_/], ['guide/', /\bguide\//]]
/** 生成的或静态的模型可见文本中禁止出现的短语。 */
const BANNED: [rule: string, where: RegExp, phrase: RegExp][] = [
  ['An out-of-scope proactive ticket ends as dropped', /^worker (prompt from the runtime|input assignment \(inferred\))$/, /report blocked|上报 blocked|报告 blocked/i],
  ['A question goes back where the person who raised it wrote', /./, /always returns to the original|ask(?: promptly)? in the original ticket conversation|(?:所有|任何)问题(?:都|一律|总是)(?:回到|留在)|问题总是回到原始/i],
  ['The main Session has no tool that messages a worker', /./, /request the answer through the worker|通过 worker 请求(?:答案|回答)|向 worker 请求答案/i],
  ['A stop goes through orchestrator_route, not through an assessment', /^assessment instructions$/, /decision\s*=\s*stop|决定\s*=\s*stop/i],
]
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
const sentences = (text: string) => text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/)

let h: Fixture
let a: Ticket
beforeAll(async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  a = ticket
})
afterAll(async () => { await h?.stop() })

/** 某角色组装后的完整 system prompt；worker 用真实工单的执行环境变量。 */
const prompt = (role: Role) => composePrompt(h.runtime.prompts.current().config, role,
  environmentSection(h.runtime.prompts.current().config, h.runtime.ticketEnvironment(a)))
/** 某角色可用的工具；schema 转成 JSON Schema，与模型实际看到的定义一致。 */
const toolsOf = (role: Role): Tool[] => h.runtime.tools(role === 'orchestrator' ? undefined : a)
  .map(tool => ({ name: tool.name, description: tool.description, parameters: toolJsonSchema(tool.schema) }))

/** 收集模型可见文本：两个角色的 prompt 与生成片段、工具 schema、skill、assignment 与工具错误。 */
function collect(): Surface[] {
  const config = h.runtime.prompts.current().config
  const shared = new Set(['runtime/shared', 'communication', 'scope', 'delivery', 'runtime/subscriptions', 'runtime/replies'])
  const surfaces: Surface[] = []
  for (const role of ['orchestrator', 'worker'] as const) {
    const parts = promptParts(config, role)
    for (const { name, text } of parts) surfaces.push({ where: `${role} prompt ${name}`, owner: PROMPTS, role: shared.has(name) ? 'both' : role, text })
    const whole = h.runtime.prompts.compose(config, role, h.runtime.ticketEnvironment(a))
    const generated = parts.reduce((text, part) => text.replace(part.text, ''), whole)
    surfaces.push({ where: `${role} prompt from the runtime`, owner: 'src/app/runtime.ts', role, text: generated })
    for (const tool of toolsOf(role)) {
      const descriptions = [tool.description]
      walk(tool.parameters, node => { if (typeof node.description === 'string') descriptions.push(node.description) })
      surfaces.push({ where: `${role} tool ${tool.name}`, owner: TOOLS, role, text: descriptions.join('\n') })
    }
  }
  for (const [name, content] of h.runtime.prompts.skills(config)) {
    const description = name === 'dsh-superagent-feishu' ? bundledSkills.feishu.description : bundledSkills.github.description
    surfaces.push({ where: `skill ${name}`, owner: PROMPTS, role: 'both', text: `${description}\n${content}` })
  }
  surfaces.push({ where: 'worker input assignment (explicit)', owner: ASSIGNMENTS, role: 'worker', text: a.execution!.assignment })
  return surfaces
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

it('registers six tools on the worker and the routing tools on the main Session', () => {
  expect(toolsOf('worker').map(tool => tool.name).sort()).toEqual(['orchestrator_ack', 'orchestrator_read', 'orchestrator_report',
    'orchestrator_thread_follow', 'orchestrator_thread_unrelated', 'orchestrator_trigger_handback'])
  const main = toolsOf('orchestrator').map(tool => tool.name)
  expect(main).toHaveLength(14)
  expect(main).toEqual(expect.arrayContaining(['orchestrator_route', 'orchestrator_eval_decide', 'orchestrator_reply']))
  for (const name of ['orchestrator_ticket_accept', 'orchestrator_ticket_attach', 'orchestrator_ticket_stop', 'orchestrator_trigger_ignore']) {
    expect(main).not.toContain(name)
  }
})

it('names only registered tools, schema options, environment variables and glossary words, with the enforced word limits', () => {
  const surfaces = collect()
  const options = new Map<string, Set<string>>()
  walk([...toolsOf('orchestrator'), ...toolsOf('worker')].map(tool => tool.parameters),
    (node, property) => { if (property && Array.isArray(node.enum)) options.set(property, new Set([...(options.get(property) ?? []), ...node.enum.map(String)])) })
  for (const name of ['decision', 'purpose', 'state']) expect(options.has(name), `${name} has options`).toBe(true)
  const tools = { orchestrator: new Set(toolsOf('orchestrator').map(tool => tool.name)), worker: new Set(toolsOf('worker').map(tool => tool.name)) }
  const registered = (token: string) => tools.orchestrator.has(token) || tools.worker.has(token)
  const variables = new Set(h.runtime.ticketEnvironment(a).map(variable => variable.key))
  const found: string[] = []
  for (const { where, role, text } of surfaces) {
    for (const [token] of text.matchAll(/\borchestrator_[a-z_]+/g)) if (!registered(token)) found.push(`${where}: ${token} is not a tool`)
    for (const [, name, values] of text.matchAll(/\b([a-z_]+)[=:] ?([a-z][a-z/-]*)/g)) {
      for (const value of options.has(name!) ? values!.split('/') : []) if (!options.get(name!)!.has(value)) found.push(`${where}: ${name}=${value} is not an option`)
    }
    for (const [word, pattern] of LEGACY) if (pattern.test(text)) found.push(`${where}: legacy word "${word}"`)
    for (const [rule, scope, phrase] of BANNED) if (scope.test(where) && phrase.test(text)) found.push(`${where}: breaks "${rule}"`)
    for (const [name] of text.matchAll(/\bDSH_SUPERAGENT_[A-Z][A-Z_]*[A-Z]\b/g)) if (!variables.has(name)) found.push(`${where}: ${name} is not a variable`)
    const states = [...text.matchAll(/\b([a-z]+(?:\/[a-z]+)*) (?:tickets?|workers?)\b/g), ...text.matchAll(/\b(?:tickets?|workers?) (?:is|are)(?: still)? ([a-z]+)\b/g),
      ...text.matchAll(/(?:工单|ticket)\s*(?:处于|仍是|已是|就是|为)\s*([a-z]+(?:\/[a-z]+)*)/g)]
    for (const [phrase, word] of states) {
      if (word!.split('/').some(part => REPORT_WORDS.test(part)) && !(TICKET_STATES as readonly string[]).includes(word!)) found.push(`${where}: "${phrase}" is not a card state`)
    }
    for (const [phrase] of text.matchAll(/\bwait(?:ing)? for (?:ready|waiting|blocked|failed)\b(?! report)/g)) found.push(`${where}: "${phrase}" names a report state without report`)
    for (const [phrase] of text.matchAll(/等待\s*(ready|waiting|blocked|failed)(?!\s*(?:汇报|报告|状态))/g)) found.push(`${where}: "${phrase}" names a report state without report`)
    for (const [name] of text.matchAll(/\b(?:ticket|trigger|decision|prompts|prompt-preview|models|feishu|github)\/[^\s"'`,;)\]。，、：；！？（）【】“”‘’]*/g)) {
      if (!RESOURCE_NAMES.some(pattern => pattern.test(name.replace(/[.:]+$/, '')))) found.push(`${where}: ${name} is not a resource`)
    }
    const other = role === 'orchestrator' ? 'worker' : role === 'worker' ? 'orchestrator' : undefined
    const names = other === 'worker' ? /\b(workers?|executors?)\b/i : /\b(orchestrator|main session)\b/i
    for (const sentence of sentences(text)) {
      for (const [, count] of sentence.matchAll(/(\d+)\s*(?:[- ]words?|个词)/g)) {
        const limit = /routing|路由/i.test(sentence) ? NOTE_WORDS : IM_WORDS
        if (Number(count) !== limit) found.push(`${where}: "${count} words" is not ${limit}`)
      }
      for (const [token] of other && !names.test(sentence) ? sentence.matchAll(/\borchestrator_[a-z_]+/g) : []) {
        if (!registered(token) || tools[role as Role].has(token)) continue
        found.push(`${where}: tells the ${role} to use ${token}, which only the ${other} has`)
      }
    }
  }
  expect(found).toEqual([])
})

it('enforces the word limits the text states', async () => {
  expect(checkedImText(words(IM_WORDS))).toBe(words(IM_WORDS))
  expect(() => checkedImText(words(IM_WORDS + 1))).toThrow(`上限为 ${IM_WORDS} 个`)
  const attach = (note: string) =>
    h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: 'unknown', trigger_id: 'unknown', note }] }) as
      Promise<{ results: Record<string, unknown>[] }>
  expect(await attach(words(NOTE_WORDS + 1))).toEqual({ results: [expect.objectContaining({ refused: expect.stringContaining(`${NOTE_WORDS} 个词`) })] })
  expect(await attach(words(NOTE_WORDS))).toEqual({ results: [expect.objectContaining({ refused: expect.stringMatching(/未知(工单| ?Trigger)/) })] })
})

it.each(['orchestrator', 'worker'] as const)('keeps the %s within its character budget', role => {
  // 测量长度前去掉依赖机器的变量值与团队规则，它们不计入固定的提示词体积。
  const rules = h.runtime.store.settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)
  const builtIn = (text: string) => rules.reduce((rest, line) => rest.replace(line, ''), text).replace(/ = "[^"\n]*"/g, ' = ""')
  const promptChars = builtIn(prompt(role)).length
  const definitions = JSON.stringify(toolsOf(role).map(({ name, description, parameters }) => ({ name, description, parameters }))).length
  expect(promptChars + definitions, `${promptChars} characters of prompt and ${definitions} of tools`).toBeLessThanOrEqual(BUDGET[role])
})

it('keeps the routing rules in dispatch, which says the main Session may accept the rest of a stop message as new work', () => {
  const route = toolsOf('orchestrator').find(tool => tool.name === 'orchestrator_route')!.description
  const dispatch = promptParts(h.runtime.prompts.current().config, 'orchestrator').find(part => part.name === 'runtime/dispatch')!.text
  expect(dispatch).toContain('你可以把消息的其余部分作为新工作接受')
  expect(dispatch).toContain('用一次 orchestrator_route 调用决定那些卡片已经能断定的候选')
  expect(route).not.toMatch(/需要另一次显式指示.*新建工单/)
})

it('lists in the main Session\'s Policy section exactly the enabled rules', () => {
  const config = h.runtime.prompts.current().config
  const text = h.runtime.prompts.compose(config, 'orchestrator', h.runtime.ticketEnvironment(a))
  const at = text.indexOf('## Policy'), end = text.indexOf('\n\n', at)
  // Policy 是最后一段，因此其后可能没有空行。
  const listed = text.slice(at, end < 0 ? undefined : end).split('\n').filter(line => line.startsWith('- '))
  const rules = h.runtime.store.settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)
  expect(listed).toEqual(rules)
})

it('states the image attachment limitation in the assessment instructions', () => {
  const admission = promptParts(h.runtime.prompts.current().config, 'orchestrator').find(part => part.name === 'runtime/admission')!.text
  expect(admission).toContain('图片附件在本版本不可读取')
})

/** 为 orchestrator_read 提供分页上下文资源，使大段正文在请求之前不进入模型提示词。 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { UserError, key, latestReport, reached, runningAssignment, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { readGithub } from '../sources/github-read.ts'
import { feishuReferences, feishuRead } from '../sources/feishu-read.ts'
import { feishuRef } from '../sources/feishu.ts'
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
import { threadTitle } from './views/records.ts'
import { transcriptEntry } from './context.ts'
import { builtInParts, defaultPrompts } from './prompts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Commands } from '../infra/commands.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

/** 通过 orchestrator_read 暴露的资源描述符，并标明哪些资源 worker session 也可为自身工单读取。 */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'ticket cards, newest first; a card\'s state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'ticket/<id>', holds: 'a ticket\'s card, the trigger, decision and threads it is tied to, its latest assignments with the start of each '
    + 'report, and its inputs, newest first', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first, with the start of each report', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to and the messages around it on its thread',
    executor: true },
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized' },
  { name: 'settings/<block>', holds: 'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or '
    + 'source:<id>' },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  { name: 'github/…', holds: 'a GitHub original, as the dsh-superagent-github skill describes', executor: true },
]
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

export interface ResourceHost {
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  readonly context: Context
  promptVersion(sessionId: string): PromptVersion
  /** Session 是否可读取 `revision`（它当前运行的修订，或此前运行过的任一修订）。 */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
}
interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** 保证仅限主 Session 的资源不能被 worker Session 读取。 */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('该资源属于主 Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** 检查 worker session 的工单是否有权读取某个 trigger（经由投递、工单来源或关注的 thread）。 */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** 在 offset 0 时获取并缓存 Source 资源，后续 offset 直接由 session 缓存提供。 */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error(`请先从 offset 0 读取该资源（来源：${source === 'feishu' ? '飞书' : 'GitHub'}）`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events
}

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    const host = main(read), tickets = host.store.tickets.list()
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
  }],
  ['triggers', read => {
    const { store } = main(read)
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Session 只能读取自身工单订阅或关注的 thread。
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Thread 不存在或不可访问')
    }
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    // Worker session 无法查看共享 thread 上的其他工单或决策。
    if (ticketId) return { ...card, ...page }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  ['decisions', read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision) throw new Error('未知的决策')
    return decisionDetails(decision)
  }],
  ['settings', read => main(read).settings.view()],
  ['settings/', read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // 自团队覆盖以来文本已发生变化的内置片段，以及本版本已不再拥有的片段，
    // 前者由面板展示，后者在下次保存时丢弃。
    const changes = host.prompts.defaultChanged(current.config)
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(name => !(name in current.config.skills)).map(name => `dsh-superagent-${name}`),
        team: Object.keys(current.config.skills).map(name => `dsh-superagent-${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // Worker Session 只能读取其当前提示词修订，以及它此前运行过的修订。
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    const bound = host.promptVersion(sessionId)
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('提示词版本不存在或不可访问')
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('该 Session 没有这个预览')
    return text(read, body)
  }],
  ['models', async read => {
    const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings()
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    return { default: catalog.default, roles, failures: catalog.failures,
      providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  ['models/', async read => {
    const models = (await main(read).context.sessionController.modelCatalog()).groups.find(group => group.id === read.rest)?.models
    if (!models) throw new Error('未知的模型 provider')
    return list(read, (offset, count) => models.slice(offset, offset + count))
  }],
  ['feishu/', async read => {
    const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
    const ref = feishuRef(source)
    if (!ref) throw new Error('需要来自飞书的 Trigger')
    const commands = read.host.commands.withSignal(read.signal)
    return sourcePage(read, 'feishu', () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()))
  }],
  ['github/', read => sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest || rest.includes('/')) throw new Error('未知的上下文资源')
    const found = trigger(host, rest, ticketId)
    const ref = feishuRef(found)
    // worker session 读取 trigger 时，隐去决策 ID、其他工单与不可达的相邻 trigger。
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    const disposition = host.store.triggers.disposition(found.id)
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) }
      : disposition
    // 省略卡片预览与自引用，因为该资源返回的就是完整文本。
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('未知的上下文资源')
    if (ticketId && ticketId !== id) throw new Error('该工单不属于这个 worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (section === undefined) {
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // 合并已订阅的 thread（含仅作上下文的订阅）与 Source 绑定的 thread，去重。
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry }
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('未知的上下文资源')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      // 按需渲染该 input 及其解析出的来源链接，可匹配其短 key 或完整 input ID。
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const trigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      const card = trigger && input?.kind === 'trigger' ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('未知的工单输入')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('未知的对话记录条目')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('未知的 Assignment 报告')
      body = report.summary
    } else if (part !== undefined) throw new Error('未知的上下文资源')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        const said = entry?.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('未知的上下文资源')
    return text(read, body)
  }],
]

/**
 * 为主 Session 或工单的 worker Session 读取分页资源。
 * 仍接受旧前缀（`event/`、`task/`、`observation/`），以便旧 Session 历史中的引用仍可读取。
 */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('未知的上下文资源')
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}

/** trigger、工单、thread、决策与渠道链接的共享视图投影。 */
import { z } from 'zod'
import { canRetry, followupOwners, latestReport, liveTicket, settled, threadKey, ticketStage, type ActorRef, type ChannelRef, type Decision,
  type DecisionKind, type Thread, type ThreadFacts, type Ticket, type TicketStage, type Trigger } from '../../core/index.ts'
import { allowedSender, listedBot } from '../../policy.ts'
import type { ChannelLink, Localized } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { Store } from '../store.ts'
import { attribute, markdown, plain, preview, readable } from './text.ts'

export type LinkTarget = (channel: ChannelRef) => ChannelLink
export interface ViewHost { store: Store; sources: SourceRegistry; links: LinkTarget }
export const page = <T>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit), total: items.length, next_offset: offset + limit < items.length ? offset + limit : null })
const DAY = 86_400_000
export const dayAgo = () => new Date(Date.now() - DAY).toISOString()
export const newestFirst = (a: Ticket, b: Ticket) => b.updatedAt.localeCompare(a.updatedAt)

/** 面向 UI 的发送者投影；自动化通知的 `id` 为空且没有 `name`。 */
export interface ActorView { source: string; id: string; name?: Localized }
/** 由 worker 决定真人后续跟进的工单（见 `followupOwners`）。 */
export type Owners = (trigger: Trigger) => string[]
/**
 * 一次请求视角下的后续跟进归属：一页中的各行共享其工单与 Thread，因此无论它决定多少行，每个
 * 只读取一次。
 */
export function ownersOf(store: Pick<Store, 'tickets' | 'threads' | 'triggers'>): Owners {
  const once = <T>(read: (id: string) => T) => {
    const seen = new Map<string, T>()
    return (id: string) => { if (!seen.has(id)) seen.set(id, read(id)); return seen.get(id) as T }
  }
  const records = { tickets: { get: once(id => store.tickets.get(id)) }, threads: { get: once(key => store.threads.get(key)) },
    triggers: store.triggers }
  return trigger => followupOwners(trigger, records)
}
/** 一次请求内的各项读取，每项只读一次：每个 Ticket 订阅的 Thread、按 id 索引的规则，以及发送者的名称。 */
export interface Snapshot extends ViewHost {
  threadsOf(ticketId: string): Thread[]
  /** 当前规则名；规则被移除后退回 `id`。 */
  rule(id: string): { id: string; name: string }
  /** 从策略允许列表或机器人列表解析发送者显示名；解析不到时退回 Source 类型的未命名标签或原始 id。 */
  actor(actor: ActorRef, human?: boolean): ActorView
  /** 后续跟进的归属（见 `ownersOf`）。 */
  owners: Owners
}
export function snapshot(host: ViewHost): Snapshot {
  const { store, sources } = host
  let subscribed: Map<string, Thread[]> | undefined
  const threadsOf = (ticketId: string) => {
    if (!subscribed) {
      subscribed = new Map()
      for (const thread of store.read.subscribedThreads()) for (const id of thread.subscriptions) subscribed.set(id,
        [...subscribed.get(id) ?? [], thread])
    }
    return subscribed.get(ticketId) ?? []
  }
  const settings = store.settings()
  const rules = new Map(settings.policy.rules.map(rule => [rule.id, rule.name]))
  const named = (name: string) => ({ zh: name, en: name })
  const actor = ({ source, id }: ActorRef, human?: boolean): ActorView => {
    if (!id) return { source, id }
    const entry = allowedSender(settings, { source, id }) ?? listedBot(settings, { source, id })
    if (entry) return { source, id, name: named(entry.name || entry.id) }
    const unnamed = sources.kind(source)?.policy?.unnamed
    return { source, id, name: unnamed ? human === false ? unnamed.bot : unnamed.person : named(id) }
  }
  return { ...host, threadsOf, rule: id => ({ id, name: rules.get(id) ?? id }), actor, owners: ownersOf(store) }
}

/**
 * Thread 队列中等待 Eval 的 Trigger：某工单仍在决定的真人后续跟进（由旧版本入队）会在下一次
 * 没有该后续的 Eval 中离开队列。
 */
export const awaitingEval = ({ store, owners }: { store: Pick<Store, 'triggers'>; owners: Owners }, thread: Thread): string[] =>
  thread.pending.filter(id => {
    const trigger = store.triggers.get(id)
    return !trigger || !owners(trigger).length
  })
/**
 * trigger 及其去向：为 Eval 排队、消费它的 Decision、它分发到的 Ticket；`delivered` 表示它是某工单的
 * worker 不经 Eval 直接决定的真人后续；还有把它交回以发起新 Eval 的 Ticket 及原因；`requeue` 表示真人可以
 * 把它送去 Eval，即没有任何 Eval 作出判断的情形：其 Source 过滤了它、其 Eval 不可用、某工单的 worker 仍在
 * 决定它，或它送达了工单但无人决定，例如 worker 既未确认、未回答也未交回的消息，
 * 或只决定了一次停止的消息。
 */
export function triggerView(view: Snapshot, trigger: Trigger, threadDecisions?: Decision[]) {
  const { store } = view
  const disposition = store.triggers.disposition(trigger.id)
  const home = store.threads.get(threadKey(trigger.threads[0]!))
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId)
    : (threadDecisions ?? (home ? store.decisions.byThread(home.key) : [])).filter(item => item.triggerIds.includes(trigger.id)).at(-1)
  const delivered = view.owners(trigger).length > 0
  const queued = !!home?.pending.includes(trigger.id) && !delivered
  const evaluating = !!home?.evaluating?.triggerIds.includes(trigger.id)
  const decided = !!disposition?.acked?.length || (!!decision && settled(decision))
  const unjudged = !!disposition?.filtered || decision?.kind === 'unavailable' || delivered || (!!disposition?.fanout.length && !decided)
    || (!!decision && !decided)
  const requeue = trigger.human && !queued && !evaluating && unjudged
  return { id: trigger.id, source: trigger.source, actor: view.actor(trigger.actor, trigger.human), human: trigger.human, at: trigger.at,
    text: plain(readable(trigger.text), true),
    preview: preview(trigger.text), url: trigger.url, threads: trigger.threads.map(threadKey), actions: { requeue },
    disposition: { queued, evaluating, delivered, filtered: disposition?.filtered, fanout: disposition?.fanout ?? [],
      handbacks: (disposition?.handbacks ?? []).map(item => ({ ...item,
        title: store.tickets.get(item.ticketId)?.title ?? item.ticketId })),
      decision: decision ? { id: decision.id, outcome: outcomeOf(decision), reason: decision.reason, ticketId: decision.ticketId }
        : undefined } }
}
export type TriggerView = ReturnType<typeof triggerView>
/** 单行摘要，说明处于 `person` 阶段的工单为何在等待人工处理（已回复并回到 Executor 后省略）。 */
function ticketNote(ticket: Ticket, stage: TicketStage): { text: string; error: boolean } | undefined {
  if (stage.stage !== 'person') return undefined
  if (stage.action === 'answer' && ticket.attention) return { text: preview(ticket.attention.question), error: false }
  if (stage.action === 'delivery' && ticket.delivery) return { text: preview(ticket.delivery.error), error: true }
  const summary = latestReport(ticket)?.summary
  if ((stage.action !== 'blocked' && stage.action !== 'failed') || !summary) return undefined
  return { text: preview(summary.split('\n')[0]!), error: stage.action === 'failed' }
}
export function ticketSummary(ticket: Ticket) {
  const stage = ticketStage(ticket)
  const note = ticketNote(ticket, stage)
  const state = liveTicket(ticket) ? 'open' as const : 'ended' as const
  return { id: ticket.id, title: ticket.title, state, ...stage, ...note ? { note } : {},
    actions: { retry: canRetry(ticket), stop: liveTicket(ticket) }, strength: ticket.mandate.strength, ended: ticket.ended,
    attention: ticket.attention && { ...ticket.attention, question: markdown(ticket.attention.question) },
      assignments: ticket.assignments.length, inputs: ticket.inputs.length, undelivered: ticket.undelivered.length,
    // 每个已启动的 Assignment 都在该工单唯一的共享 worker Session 中运行。
    deliveryError: attribute(ticket.delivery?.error), sessionId: ticket.assignments.some(item => item.startedAt)
      ? workerSessionId(ticket.id) : '',
    directory: attribute(ticket.execution?.directory), summary: latestReport(ticket)?.summary ?? '', createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt }
}
export type TicketSummaryView = ReturnType<typeof ticketSummary>
function threadUrl(store: Store, thread: Thread): string | undefined {
  return attribute(thread.meta.url) ?? store.read.firstTrigger(thread.key)?.url
}
export function threadFacts(store: Store, thread: Thread) {
  const url = threadUrl(store, thread)
  return { key: thread.key, source: thread.ref.source, title: threadTitle(store, thread), ...url ? { url } : {}, facts: (thread.meta.facts ?? {}) as ThreadFacts }
}
export type ThreadFactsView = ReturnType<typeof threadFacts>
export const ticketLine = (view: Snapshot, ticket: Ticket) => ({ ...ticketSummary(ticket),
  threads: view.threadsOf(ticket.id).map(thread => threadFacts(view.store, thread)) })
export function threadTitle(store: Pick<Store, 'read'>, thread: Thread): string {
  const label = attribute(thread.meta.label)
  if (label) return label
  // 推导兜底 thread 标题时，优先使用第一条真人 trigger 而非自动化 trigger。
  const first = store.read.firstTrigger(thread.key, true) ?? store.read.firstTrigger(thread.key)
  return first ? preview(first.text, 80) : thread.key
}
function latestOnThread(view: Snapshot, thread: Thread) {
  const trigger = view.store.read.threadTriggers(thread.key, 1)[0]
  if (!trigger) return undefined
  return { actor: view.actor(trigger.actor, trigger.human), human: trigger.human, at: trigger.at, preview: preview(trigger.text, 120) }
}
/** Thread 生命周期阶段，按优先级排序：轮询错误、评估中、排队中、被未结束工单订阅、休眠（仅有已结束工单）或已取消订阅。 */
export type ThreadStage = 'error' | 'evaluating' | 'queued' | 'subscribed' | 'dormant' | 'unsubscribed'
function threadStage(thread: Thread, pending: number, tickets: { state: string }[]): ThreadStage {
  if (attribute(thread.meta.pollError)) return 'error'
  if (thread.evaluating) return 'evaluating'
  if (pending) return 'queued'
  if (tickets.some(ticket => ticket.state === 'open')) return 'subscribed'
  return tickets.length ? 'dormant' : 'unsubscribed'
}
export function threadSummary(view: Snapshot, thread: Thread) {
  const { store } = view
  const tickets = thread.subscriptions.map(id => {
    const ticket = store.tickets.get(id)
    return { id, title: ticket?.title ?? id, state: !ticket ? 'unknown' : liveTicket(ticket) ? 'open' : 'ended' }
  })
  const pending = awaitingEval(view, thread).length
  return { key: thread.key, source: thread.ref.source, title: threadTitle(store, thread), stage: threadStage(thread, pending, tickets),
    latest: latestOnThread(view, thread), lastAt: thread.lastAt ?? thread.createdAt, createdAt: thread.createdAt,
    subscriptions: thread.subscriptions.length, tickets,
    evaluating: thread.evaluating ? { id: thread.evaluating.id, strength: thread.evaluating.strength, triggers: thread.evaluating.triggerIds.length, startedAt: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } : undefined,
    pending, pollError: attribute(thread.meta.pollError), url: threadUrl(store, thread),
    facts: (thread.meta.facts ?? {}) as ThreadFacts }
}
export type ThreadSummaryView = ReturnType<typeof threadSummary>
/** 解析渠道链接；当来源链接指向某个 trigger 时，优先使用该 trigger 的具体 URL。 */
export function channelLink({ store, links }: ViewHost, channel: ChannelRef) {
  const { url, label, triggerId } = links(channel)
  return { source: channel.source, url: (triggerId && store.triggers.get(triggerId)?.url) || url, label }
}
/** 解析已存储的评估审计元数据，容忍旧版本省略或形状不同的字段。 */
const AuditSchema = z.object({
  would_accept: z.boolean().optional().catch(undefined),
  rule_assessments: z.array(z.object({ rule_id: z.string(), matched: z.boolean(), reason: z.string() })).optional().catch(undefined),
  matches: z.array(z.object({ rule_id: z.string(), reason: z.string() })).optional().catch(undefined),
  direction: z.object({ implementation_requested: z.boolean(), target_basis: z.string(), requires_design_decision: z.boolean(),
    evidence: z.string() }).optional().catch(undefined),
}).catch({})
/** 决策 kind；对 observe 模式本会接受的 ignore 决策则用 `wouldAccept`。 */
export type DecisionOutcome = DecisionKind | 'wouldAccept'
const outcomeOf = (decision: Decision): DecisionOutcome =>
  decision.kind === 'ignore' && AuditSchema.parse(decision.audit ?? {}).would_accept ? 'wouldAccept' : decision.kind
export function decisionView(view: Snapshot, decision: Decision) {
  const { store } = view
  const thread = store.threads.get(decision.threadKey)
  const texts = decision.triggerIds.flatMap(id => { const trigger = store.triggers.get(id); return trigger ? [preview(trigger.text)] : [] })
  const audit = AuditSchema.parse(decision.audit ?? {})
  // 对旧版本记录的评估退回使用 `matches`。
  const judged = audit.rule_assessments ?? audit.matches?.map(match => ({ ...match, matched: true })) ?? []
  return { id: decision.id, kind: decision.kind, outcome: outcomeOf(decision), reason: decision.reason, at: decision.at,
    strength: decision.strength, ticketId: decision.ticketId, triggerIds: decision.triggerIds, thread: decision.threadKey,
    rules: judged.map(rule => ({ ...view.rule(rule.rule_id), matched: rule.matched, reason: rule.reason })),
    ...audit.direction ? { direction: audit.direction } : {},
    ...thread ? { threadTitle: threadTitle(store, thread) } : {}, preview: texts.join(' / '),
    ticketTitle: decision.ticketId ? store.tickets.get(decision.ticketId)?.title : undefined }
}
export type DecisionView = ReturnType<typeof decisionView>

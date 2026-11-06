/** 总览视图：当前系统问题、等待人工处理的工单、执行器负载，以及 24 小时 trigger 流量。 */
import { reasonText, ticketStage, type Decision, type Thread } from '../../core/index.ts'
import type { Health } from '../../sources/host.ts'
import type { SetupProblem } from '../../setup.ts'
import { anyoneAllowed } from '../../policy.ts'
import type { Store } from '../store.ts'
import { awaitingEval, dayAgo, newestFirst, ownersOf, snapshot, threadSummary, type ViewHost } from './records.ts'
import { sourceHealth, type HealthMap } from './sources.ts'
import { ticketRow, type ExecutorLoad } from './tickets.ts'
import { preview } from './text.ts'

/** 自 `since` 以来最新决策为未忽略的 `unavailable` eval，且既未在评估也未排队的 thread。 */
function unjudged(store: Store, since: string): { thread: Thread; decision: Decision }[] {
  const seen = new Set<string>()
  const queue = { store, owners: ownersOf(store) }
  return store.read.decisionsOfKinds(['unavailable'], 200).filter(decision => decision.at >= since).flatMap(decision => {
    if (seen.has(decision.threadKey)) return []
    seen.add(decision.threadKey)
    const thread = store.threads.get(decision.threadKey)
    if (!thread || thread.evaluating || awaitingEval(queue, thread).length || decision.dismissed) return []
    if (store.decisions.byThread(thread.key).at(-1)?.id !== decision.id) return []
    return [{ thread, decision }]
  })
}
/** 当某 thread 最近一小时内有未忽略的 `unavailable` eval，且之后没有更新的决策或进行中的评估时，报告错误健康状态。 */
export function evalsHealth(store: Store, now = Date.now()): Health {
  const since = new Date(now - 3_600_000).toISOString()
  const open = unjudged(store, since)
  if (!open.length) return { state: 'ready', detail: 'No unavailable Eval in the last hour' }
  const latest = open[0]!.decision
  return { state: 'error', at: latest.at, detail: `${open.length} Eval(s) unavailable in the last hour without a later judgement; `
    + `the latest on ${latest.threadKey}: ${reasonText(latest.reason)}` }
}
/**
 * 构建运维总览：当前系统问题、等待人工处理的工单、执行器负载，以及 24 小时 trigger 流量。
 * @param setup - 优先展示的 setup 问题（setup 中断的位置，或被 setup 暂停的 Source）。
 */
export function overview(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem) {
  const { store, sources } = host
  const view = snapshot(host)
  const settings = store.settings()
  const now = new Date().toISOString(), since = dayAgo()
  const evaluating = store.threads.active().filter(thread => thread.evaluating)
  const instances = sources.instances()
  const running = instances.filter(instance => instance.enabled && instance.installed).map(instance => sourceHealth(sources, instance, health))
  // 排除 Source 自有与 policy-sync 的健康条目，使只有核心运行时错误以 `runtime-error` 呈现。
  const sourceParts = new Set(instances.flatMap(instance => sources.kind(instance.kind)?.health ?? []))
  const problems = [
    ...(setup ? [{ kind: 'setup' as const, ...setup }] : []),
    ...(running.length ? [] : [{ kind: 'no-source' as const }]),
    // 只有被允许的发送者才能发起工作，因此允许列表为空时任何请求都不会变成工单。
    ...(anyoneAllowed(settings) ? [] : [{ kind: 'no-allowed' as const }]),
    ...running.flatMap(source => source.health.filter(item => item.state === 'error').map(item => ({ kind: 'source-error' as const, source: { id: source.id, title: source.title, health: item } }))),
    ...(settings.paused ? [{ kind: 'executor-paused' as const }] : []),
    // `evals` 健康条目背后的不可用 Eval 会在下方以 `eval-unavailable` 逐条列出。
    ...Object.entries(health).filter(([name, item]) => item.state === 'error' && !sourceParts.has(name) && !name.startsWith('sync:')
      && name !== 'evals')
      .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
    ...evaluating.filter(thread => thread.evaluating!.deadline < now)
      .map(thread => ({ kind: 'eval-overdue' as const, thread: threadSummary(view, thread) })),
    ...unjudged(store, since).map(({ thread, decision }) => ({ kind: 'eval-unavailable' as const, decisionId: decision.id,
      thread: threadSummary(view, thread), reason: decision.reason, triggerId: decision.triggerIds[0] ?? '' })),
    ...store.read.failingReplies().map(item => ({ kind: 'outgoing' as const, outgoing: { id: item.id, channel: item.channel,
      text: preview(item.text),
      attempts: item.attempts, error: item.error } })),
  ]
  const open = store.tickets.open().sort(newestFirst)
  const stats = Object.values(store.read.triggerStats(since))
  const received = stats.reduce((sum, item) => sum + item.received, 0), filtered = stats.reduce((sum, item) => sum + item.filtered, 0)
  const judgement = store.read.flow(since)
  return {
    problems,
    person: open.filter(ticket => ticketStage(ticket).stage === 'person').map(ticket => ticketRow(view, ticket)),
    executor: { ...load, maxWorkers: settings.executor.maxWorkers, idle: open.filter(ticket => ticketStage(ticket).stage === 'idle').length },
    flow: { received, filtered, triggers: received - filtered, judged: judgement.judged, accepted: judgement.accepted,
      evaluating: evaluating.length, dropped: store.read.droppedSince(since) },
    policyVersion: policyVersionValue,
  }
}
export type OverviewView = ReturnType<typeof overview>

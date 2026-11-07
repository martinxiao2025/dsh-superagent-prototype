/** Source 状态视图：每个 Source 实例的健康状态、24 小时触发计数，以及近期被过滤或丢弃的消息。 */
import { threadKey } from '../../core/index.ts'
import type { Deployment } from '../../deployment.ts'
import type { Health } from '../../sources/host.ts'
import type { SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { dayAgo, snapshot, type ViewHost } from './records.ts'
import { preview } from './text.ts'

export type HealthMap = Record<string, Health>
/** 解析一个 Source 实例的健康条目；已启用的 Source 上过期的 `sourceOff` 条目按 `starting` 处理。 */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kind(instance.kind)
  const starting: Health = { state: 'starting', detail: '' }
  const parts = (kind?.health ?? []).map(name => {
    const entry = health[name]
    return { name, ...(!entry || (instance.enabled && entry.code === 'sourceOff') ? starting : entry) }
  })
  return { id: instance.id, title: kind?.title ?? { zh: instance.id, en: instance.id }, health: parts }
}
export interface SetupState {
  /** 已解析的部署事实；等待初始 setup 期间为 undefined。 */
  deployment?: Deployment | undefined
  /** 使所有 Source 停止的 setup 失败。 */
  problem?: SetupProblem | undefined
  /** 只暂停飞书 Source 的飞书机器人检查失败。 */
  feishuProblem?: SetupProblem | undefined
}
export const problemOf = (id: string, setup: SetupState) => [setup.problem, setup.feishuProblem].find(problem => problem?.place === id)
/** Source 生命周期状态，按优先级排列：缺少 kind、被禁用、setup/部件错误、被全局 setup 阻塞、启动中、已暂停或就绪。 */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  if (setup.problem) return 'setup'
  if (parts.some(part => part.state === 'starting')) return 'starting'
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  const { store, sources } = host
  const view = snapshot(host)
  const since = dayAgo()
  const stats = store.read.triggerStats(since)
  const filtered = (source: string) => store.read.triggers({ source, filtered: true }, 0, 5).items.filter(trigger => trigger.at >= since)
    .map(trigger => ({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human), preview: preview(trigger.text, 120),
      reason: store.triggers.disposition(trigger.id)?.filtered }))
  const dropped = droppedReplies(host)
  return sources.instances().map(instance => {
    const { health: parts, ...named } = sourceHealth(sources, instance, health)
    const problem = problemOf(instance.id, setup)
    return { ...named, installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
      ...problem ? { problem } : {}, stats: stats[instance.id] ?? { received: 0, filtered: 0, lastAt: '' }, filtered: filtered(instance.id),
      dropped: dropped.filter(item => item.channel.source === instance.id) }
  })
}
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** 最近 24 小时内被丢弃的回复，附上其关联的工单与线程。 */
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // 取准确的 24 小时丢弃计数，使本列表的长度与总览的 `dropped` 指标一致。
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    const { triggerId } = links(item.channel)
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}

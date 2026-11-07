/** 为主 Session 解析 Source 消息链接并组装候选卡片。 */
import type { Candidate, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { readFeishuLink } from '../sources/feishu-read.ts'
import { feishuRef, feishuSettings } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { triggerMessage } from '../executor/dsh.ts'
import { relatedTickets, ticketCard, triggerCard } from './cards.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

export interface LinkHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets'>
  readonly links: TextCache
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly lifetime: AbortSignal
}

/** 解析并缓存触发的消息外链；查询失败时回退为可读的资源路径。 */
export async function sourceLink(host: LinkHost, trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  if (trigger.url) return { source_url: trigger.url }
  const ref = feishuRef(trigger)
  if (!ref) return {}
  const cacheKey = `${ref.chatId}:${ref.messageId}`
  const cached = host.links.get(cacheKey)
  if (cached) return { source_url: cached }
  let url: string
  try {
    const timeout = AbortSignal.timeout(feishuSettings(host.sources).linkTimeoutMs)
    url = await readFeishuLink(host.commands.withSignal(AbortSignal.any([signal ?? host.lifetime, timeout])), ref)
  } catch {
    host.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    // 可选的链接增强可能失败，这与保留的来源消息无关。
    return { source_url_read: `feishu/${trigger.id}/message` }
  }
  host.links.set(cacheKey, url)
  return { source_url: url }
}

export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  const parent = sources.repliesTo(trigger)
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** 查找订阅了 `trigger.text` 所引用线程（如 `#12` 或 URL）且不在 `known` 中的工单。 */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** 构建主 Session 的候选卡片，包含路由元数据、交回（handback）历史以及相关或被引用的工单。 */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // 执行器 Session 以超出其工单范围为由交回的触发，并附执行器给出的理由。
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // 把主触发格式化成执行器输入的样子（包括它回复的消息），并把更早的批量触发摘要为卡片。
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: candidate.strength === 'explicit' ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}

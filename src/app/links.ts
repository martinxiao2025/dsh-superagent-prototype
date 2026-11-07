/** 为主 Session 解析 Source 消息链接并组装候选卡片。 */
import type { Candidate, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { readFeishuLink } from '../sources/feishu-read.ts'
import { feishuRef, feishuSettings } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { triggerMessage } from '../executor/messages.ts'
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

/** 解析并缓存 trigger 的外部消息 URL；查找失败时退回到可读的资源路径。 */
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
    // 链接补充是可选的增强，失败与已保留的源消息无关。
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
/** 找出订阅了 `trigger.text` 中引用的 thread（例如 `#12` 或 URL）且尚未出现在 `known` 中的工单。 */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** 构建主 Session 的候选卡片，包含路由元数据、交回历史，以及相关或被引用的工单。 */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // 被 worker Session 以超出工单范围为由交回的 trigger，附上 worker 给出的原因。
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // 把主 trigger 按 worker 输入的形式呈现（含它所回复的消息），并把同批较早的 trigger 汇总为卡片。
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: candidate.strength === 'explicit' ? '按 dispatch 所述用 orchestrator_route 路由它：accept、attach、stop 或 ignore。'
      : '如果卡片显示它不涉及任何已启用规则，就用 orchestrator_route 忽略它；否则先用 orchestrator_eval、orchestrator_eval_read 评估它，再用 orchestrator_eval_decide。' }
}

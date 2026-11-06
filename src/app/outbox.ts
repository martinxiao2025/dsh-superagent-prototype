/** 可靠的外发消息投递：以持久化回执为依据，并对回复 effect 重试。 */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  paused(): boolean
}

/**
 * 把外发渠道消息持久化为回执，并通过 `Effects` 与 `SourceRegistry` 顺序投递。
 * 为 `Engine` 与 source 上下文实现核心 `Outbox` 端口，保证每个工单在各会话内按序投递，直到某条较早的消息反复失败。
 * 处理暂停或 Source 不可用时消息会等待；目标会话被忽略或已不存在时，消息按丢弃结算。
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** 原子地记录消息回执并入队其投递 effect；重复的消息 ID 会被忽略。 */
  send(message: OutboundMessage): void {
    // 在此校验 IM 回复长度；确认文本在决定时已经校验过。
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // 同一工单、同一会话中，在较早的待投递消息超过失败阈值之前，后续消息排在其后。
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // 永久不可达的目标（例如已撤回的消息或已删除的 Issue）按 `channelGone` 结算，其回执可阻止后续重试。
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}

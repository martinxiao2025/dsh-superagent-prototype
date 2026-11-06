/** Trigger 摄入、thread 关联、订阅分发与评估排队。 */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * 摄入来自 Source 的 trigger，在记录 thread 关联之前先对照 SourceScope 去重并过滤。
 * 通过 Tickets 把已监听的 trigger 分发给订阅的 ticket，并把没有 ticket 的 worker 裁决的每个 trigger（见 `followupOwners`）
 * 排入其主 thread 的评估队列。Engine 把 trigger 的接收工作委托给该部分。
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // 把 source 时间戳（例如 GitHub 的整秒时间）规范化为标准 ISO 形式。
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('一个 Trigger 至少属于一个 Thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // 记录已抵达的 ticket，以及它们是否仅通过 context thread 抵达（ticket 自身的 thread 会使 `context` 为 false）。
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // 只有非 context thread 上的人的消息才会恢复已结束的 ticket；机器人与 CI 不会（Executor 在恢复时会重读
        // thread）；被人停止的 ticket 不收任何内容，因为其 Mandate 已被撤回。
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // 没有 ticket 裁决的人的消息（例如只抵达了被人停止的 ticket、或仅为上下文跟随该 Thread 的 ticket），
    // 以及所有机器人的消息，都进入 Eval。
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}

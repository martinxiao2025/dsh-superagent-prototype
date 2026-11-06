/** Engine 各领域部分共用的基类与配置。 */
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts'

export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** 决定某个 Source 是否监听某个 trigger；不监听的 trigger 会以 `filtered` 处置记录存储。 */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  now?: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Intake、Evals、Tickets、Assignments 与 Replies 的基类，提供对仓储、policy、时钟与事件发射的共享访问。
 * 每个子类只变更自己的领域聚合，并把跨聚合的变更委托给兄弟部分，全部在 Engine 开启的事务内完成。
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  protected policy(): Policy { return this.options.policy() }
  /** 其 worker 裁决某人后续消息的 ticket：见 `followupOwners`。 */
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** 拒绝主 Session 对仍由某个 ticket 的 worker 裁决的后续消息进行路由。 */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  /**
   * 记录某个 ticket 的 worker 交还了已抵达该 ticket 的 Trigger 及其原因，并在该 ticket 裁决过它而其他 ticket 都不再裁决
   * 时把它排入 Eval。该 ticket 未裁决的（例如机器人发来的、已有人送到 Eval 的、或位于仅为上下文跟随的 Thread 上的）
   * 在没有它的情况下就已进入 Eval。
   * @returns 是否已排队。
   */
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  /** 记录某个 ticket 的 worker 通过确认或回答，把人的消息视为 ticket 范围内并接手了它。 */
  protected takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  /** 把 Trigger 排入其主 Thread 的下一次 Eval，除非它已在那里等待或已被某个 Eval 持有。 */
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** 返回已存储的 Thread，或一个未保存的空 Thread 聚合。 */
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}

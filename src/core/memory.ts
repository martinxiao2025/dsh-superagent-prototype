/** 用于测试与临时引擎实例的内存仓储实现。 */
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts'
import type { Repositories } from './ports.ts'

const clone = <T>(value: T): T => structuredClone(value)
/**
 * Repositories 端口的内存实现，底层存储克隆后的 Map 条目，因此调用方的改动不会影响已存储状态。
 * 提供基于快照的原子回滚，并与 Engine 测试所用的 SQLite 存储在排序语义上保持一致。
 */
export class MemoryRepositories implements Repositories {
  private readonly triggerRows = new Map<string, Trigger>()
  private readonly dispositions = new Map<string, TriggerDisposition>()
  private readonly threadRows = new Map<string, Thread>()
  private readonly ticketRows = new Map<string, Ticket>()
  private readonly decisionRows = new Map<string, Decision>()
  atomic<T>(work: () => T): T {
    const maps: Map<string, unknown>[] = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows]
    const snapshot = maps.map(map => new Map(map))
    try { return work() }
    catch (error) {
      maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index]!) map.set(id, value) })
      throw error
    }
  }
  readonly triggers = {
    get: (id: string) => clone(this.triggerRows.get(id)),
    save: (trigger: Trigger) => { this.triggerRows.set(trigger.id, clone(trigger)) },
    disposition: (id: string) => clone(this.dispositions.get(id)),
    saveDisposition: (id: string, value: TriggerDisposition) => { this.dispositions.set(id, clone(value)) },
  }
  readonly threads = {
    get: (key: string) => clone(this.threadRows.get(key)),
    save: (thread: Thread) => { this.threadRows.set(thread.key, clone(thread)) },
    list: () => [...this.threadRows.values()].map(clone),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => clone(this.ticketRows.get(id)),
    save: (ticket: Ticket) => { this.ticketRows.set(ticket.id, clone(ticket)) },
    /** 最新的在前，与 SQLite Store 的顺序一致。 */
    list: () => [...this.ticketRows.values()].reverse().map(clone),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => clone(this.decisionRows.get(id)),
    save: (decision: Decision) => { this.decisionRows.set(decision.id, clone(decision)) },
    byThread: (key: string) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
  }
}

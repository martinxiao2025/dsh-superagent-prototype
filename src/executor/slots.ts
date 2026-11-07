/** worker 并发槽位：运行中的 worker 与启动预留共享同一个上限。 */
import { Later } from '../app/effects.ts'

/**
 * 依据配置的并发上限跟踪活跃与正在启动的 worker 回合：工单在其回合运行期间，以及某次启动或唤醒
 * 正在启动该 worker 期间，占用一个槽位。执行器在等待启动或唤醒之前同步预留槽位，因此两次启动不会同时
 * 抢到最后一个槽位；并允许人工跟进（`by === 'person'`）在超出上限时额外使用一个槽位，使它们不会排在
 * 新启动之后。
 */
export class WorkerSlots {
  /** 当前持有启动槽位的工单，值为该启动是 launch、wake，还是因人消息而 wake。 */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - 返回其 worker 持有槽位的工单 ID（见 `HostExecutor.running`）。
   * @param max - 返回配置的并发 worker 槽位上限。
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** 当前已使用的槽位数，含运行中的 worker 与启动预留。 */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** 可并发执行的启动数量：未被运行中的 worker 或唤醒预留占用的槽位。 */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * 为 `ticketId` 预留一个启动槽位；若 `ticketId` 已持有启动槽位则幂等。
   * 因人消息而唤醒（`by === 'person'`）可在 `max()` 之外额外使用一个槽位。
   * 在 worker 回合开始运行或启动/唤醒尝试结束后调用 `free(ticketId)`。
   * @throws Later 当没有空闲槽位时。
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('没有空闲的 worker 槽位')
    this.starting.set(ticketId, by)
  }
  /** 在其 worker 回合开始运行或启动/唤醒尝试结束后，释放 `ticketId` 的启动槽位。 */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

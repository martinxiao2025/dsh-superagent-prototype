/** 协调周期性触发的与按需的编排 pass，驱动到期的 effect 与 Engine 评估。 */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * 调度并串行化编排 pass，用于触发到期的 `Effects` 并推进 `Engine` 评估。
 * 生命周期由 `Runtime` 管理；当有新工作到达或状态变化时，Source、工具、`Settings` 与 HTTP 路由会触发即时 pass。
 * pass 失败时更新运行时的 `HealthEntry`，并在随后的 pass 成功后清除该错误。
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  constructor(private readonly host: PassesHost) {}
  start(): void { if (!this.stopped) this.timer = setInterval(() => { this.request() }, 2000) }
  stop(): Promise<unknown> {
    this.stopped = true
    clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('编排器正在停止')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: '编排器已就绪', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `一次 pass 失败：${String(error)}`, at: now() }) })
  }
  /** 等待直到当前可启动的 pass 与 effect 都不再运行。 */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** 执行一次 pass，并把并发调用合并为一次后续 pass。 */
  async pump(): Promise<void> {
    // 等待 setup 期间不做评估、派发或发送；排队的工作会等完成 setup 的那次重启。
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // 处理暂停期间，Engine 只在活跃 Eval 上记录暂停，以免它们过期。
    this.host.engine.evaluateDue()
  }
}

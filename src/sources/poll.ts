/** 面向已订阅线程的共享轮询辅助：重叠安全游标与对计时器友好的延时。 */
import { liveTicket, type Thread } from '../core/index.ts'
import type { SourceContext } from './host.ts'

/** 没有活跃工单的已订阅 Thread，在其最后一次触发或工单结束后仍会继续被轮询的时长。 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000
/** 当已订阅线程拥有活跃工单，或在 `POLL_HORIZON_MS` 内有近期活动/完成时为真。 */
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id))
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? '')]
    .map(Date.parse).filter(Number.isFinite)
  return now - Math.max(...times) < POLL_HORIZON_MS
}
/** 将轮询开始时间戳回拨 5 秒，使迟到的远端事件不被遗漏；确定性触发 ID 会对重叠去重。 */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()
/** 在地平线内独立轮询 `source` 的每个已订阅 Thread；失败时在线程上记录为 `pollError`（除非 `stopped()`），成功时清除 `pollError`。 */
export async function pollThreads(ctx: SourceContext, source: string, stopped: () => boolean, poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false): Promise<void> {
  for (const thread of ctx.threads.subscribed(source)) {
    if (stopped()) return
    if (skip(thread) || !polled(ctx, thread)) continue
    try {
      await poll(thread)
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      ctx.threads.patch(thread.key, { pollError: String(error) })
    }
  }
}
/** 使用全局 `setTimeout` 等待 `ms` 毫秒或直到 `signal` 中止，使测试的假计时器能够驱动轮询循环。 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * 表示某个 effect 当前无法运行，例如处理已暂停或 worker 槽位已满。
 * Effects 会在初始重试延迟后重新调度该行且不增加其失败计数；HostExecutor 会在启动与投递处理器中抛出它。
 */
export class Later extends Error {}
/** 某种 effect 报告错误前允许的连续失败次数，与 Source 轮询的失败阈值一致。 */
export const FAILURES_BEFORE_ERROR = 3
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

export interface EffectPayloads {
  /** 构建 Eval 的候选卡片并中继到主 Session；key 是 Eval ID。 */
  assessment: { triggerId: string }
  /** 启动待处理的 Assignment；key 是 Assignment ID。 */
  launch: { ticketId: string; assignmentId: string }
  /** 把工单上等待中的 Input 交给其运行中的 Assignment；key 是 Ticket ID。 */
  delivery: { ticketId: string }
  /** 把报告或候选引导进主 Session；key 是 request ID。 */
  relay: { text: string }
  /** 向主 Session 注入通知但不唤醒它；key 指明它报告的对象，例如 `prompts`。 */
  notice: { value: Record<string, unknown>; summary: string }
  /** 通过其 Source 为某个 Channel 发送消息；key 是消息 ID，Outbox 会保存它的回执。 */
  reply: Record<string, never>
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** 当前可同时运行的数量；0 表示暂缓该 kind，例如处理暂停期间。 */
  limit: () => number
  /** 初始与最大重试退避延迟，单位毫秒。 */
  retry: readonly [number, number]
  /** effect 按队列顺序逐个运行，失败的一条会挡住同 kind 的后续行。 */
  ordered: boolean
  /** 为 true 时，反复失败不会把该 effect kind 的健康条目标为 `error`（用于失败已在工单上呈现的情况）。 */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` 保留该行的队列位置；`generation` 在载荷更新时递增，使运行中的尝试不会删除更新的载荷。 */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }

/**
 * 基于 SQLite 的持久队列：在命令事务内持久化副作用，并在提交后派发。
 * 为 MasterAssessor、HostExecutor、Sessions 与 Outbox 统一协调按 kind 的处理器、并发上限、指数退避与健康上报。
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** 上次派发失败的 kind；下一次成功派发会刷新它们的健康状态。 */
  private readonly broken = new Set<EffectKind>()
  private seq: number
  private scheduled = false
  /** effect 只在 `start` 与 `drain` 之间运行；`start` 之前入队的行会等待，例如 setup 尚未完成期间。 */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** 在调用方事务中 upsert 一个 effect，与同 kind、同 key 的等待行合并，同时保留其队列位置。 */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`${kind} 的 effect 已经有处理器`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /** 按 kind 与 key 删除排队中的行；若它已在运行，该次尝试会正常结束。 */
  cancel(kind: EffectKind, key: string): void {
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** 当 `kind`（或任意 kind）的 effect 都不在运行、且因未到期或 `limit()` 无空位而无法启动时就绪。 */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** 停止启动新的 effect 并等待运行中的结束；等待中的行保留在 SQLite 中供下次启动使用。 */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // 有序 kind 即使最早的行尚未到期也要排在它后面；只有在存在就绪行之后才查询 limit()。
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), 16 + running.size)) as unknown as Row[]
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        let room = ready.length ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // 同时匹配 seq 与 generation，使运行期间被替换或重新入队的行不会被覆盖。
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow)
    // 关闭时保留正在运行的行不动，使它们在下次启动时重试。
    else if (this.stopped) return
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
        .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
    }
    if (!this.stopped) this.report(kind)
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `effect 队列失败：${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    const waiting = Number(row?.waiting ?? 0)
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const detail = waiting ? `${waiting} 项自 ${String(row?.since)} 起等待` : '没有待处理项'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}；最近一次失败：${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}

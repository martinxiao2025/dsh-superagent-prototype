/**
 * 表示某个 effect 现在不能运行，例如处理已暂停或所有执行器槽位已满。
 * Effects 会在初始重试延迟后重新调度该行且不增加失败计数；DshExecutor 在 launch 和 delivery 处理器中抛出它。
 */
export class Later extends Error {}
/** 一类 effect 在上报错误前允许的连续失败次数，与 Sources 轮询失败阈值一致。 */
export const FAILURES_BEFORE_ERROR = 3
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

export interface EffectPayloads {
  /** 构建一次评估（Eval）的候选卡片并中继给主 Session；键为 Eval ID。 */
  assessment: { triggerId: string }
  /** 启动一个待处理的派工（Assignment）；键为派工 ID。 */
  launch: { ticketId: string; assignmentId: string }
  /** 把工单等待中的输入（Input）交给其运行中的派工；键为工单 ID。 */
  delivery: { ticketId: string }
  /** 把一份报告或一个候选转向送入主 Session；键为请求 ID。 */
  relay: { text: string }
  /** 向主 Session 注入通知而不唤醒它；键说明其内容，如 `prompts`。 */
  notice: { value: Record<string, unknown>; summary: string }
  /** 经其 Source 为某个渠道（Channel）发送消息；键为消息 ID，其回执由发件箱（Outbox）保存。 */
  reply: Record<string, never>
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** 此刻允许多少个同时运行；0 表示挂起该类 effect，例如处理暂停期间。 */
  limit: () => number
  /** 初始与最大重试退避延迟，单位毫秒。 */
  retry: readonly [number, number]
  /** 该类 effect 按队列顺序逐个运行，失败的一个会阻塞同类的后续行。 */
  ordered: boolean
  /** 为 true 时，反复失败不会把该类 effect 的健康条目标为 `error`（用于失败已在其工单上呈现的情况）。 */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` 保留该行的队列位置；`generation` 在负载更新时递增，使正在运行的尝试不会删除更新的负载。 */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }

/**
 * 基于 SQLite 的持久化队列：在命令事务内保存副作用，并在提交后分发它们。
 * 为 MasterAssessor、DshExecutor、Sessions 和发件箱（Outbox）协调每类 handler、并发限制、指数退避与健康上报。
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** 最近一次分发失败的 effect 类别；下一次成功的分发会刷新它们的健康状态。 */
  private readonly broken = new Set<EffectKind>()
  private seq: number
  private scheduled = false
  /** effect 只在 `start` 与 `drain` 之间运行；`start` 之前入队的行会等待，例如 setup 未完成时。 */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** 在调用方的事务内 upsert 一个 effect，与同类同键的等待行合并，同时保留其队列位置。 */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /** 按类别和键删除一行排队中的 effect；若已在运行，则该次尝试正常完成。 */
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
  /** 当 `kind`（或所有类别）没有 effect 在运行、也没有能启动的（没有到期的或 `limit()` 没有余量）时 resolve。 */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** 停止启动新 effect 并等待运行中的完成；等待中的行留在 SQLite 里等下次 start。 */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // 有序类别被其最老的行阻塞，即使该行尚未到期；只有在存在就绪行之后才查询 limit()。
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
    // 关闭时不动运行中的行，让它们在下次 start 时重试。
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
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    const waiting = Number(row?.waiting ?? 0)
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}

/** 领域聚合、键值状态、设置历史与渠道 outbox 的 SQLite 持久化。 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact,
  type ThreadFacts, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import { KV, type Family, type Key } from '../kv.ts'
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../policy.ts'
import { OLDEST_SCHEMA, SCHEMA_VERSION, migrateTo11, tooOld } from './migration.ts'
import { Versions } from './versions.ts'
import { storeReads } from './store-read.ts'

/** Trigger 在 thread 时间线上的位置，先按时间戳排序，再以 `id` 作为并列时的次序。 */
export interface TimelinePlace { at: string; id: string }
/** 消息被丢弃的原因：其会话永远无法接收（`channelGone`），或其 Source 已不再监听它（`channelIgnored`）。 */
export type DropReason = 'channelGone' | 'channelIgnored'
/** 自入队瞬间即在 outbox 中跟踪的外发消息回执（`pending`、`sent` 或 `dropped`）；投递尝试次数记录在其 `reply` effect 上。 */
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** 被丢弃的外发消息回执，含丢弃时间戳与原因。 */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** 已保存的设置快照，含它产生的 Policy 版本与工单通知（`internal` 保存没有来源）。 */
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}
/**
 * 生成列与部分索引，用于定义活跃工作集，使 pass 只扫描活跃行。
 * 缺少某列的旧数据库会在打开时补上该列，并由 SQLite 从已存储的 JSON 行中填充。
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // 只有最新的 assignment 可能处于 pending 或 running，因为 Engine 会在添加下一个之前关闭前一个。
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // 复合键（ticketId + thread），用于保持各会话的回复顺序。
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
}
export { SCHEMA_VERSION }
/**
 * SQLite 后端存储，实现领域 `Repositories`、视图读取查询、版本化设置、outbox 回执与键值状态。
 * Runtime 在锁定状态目录之后打开它，并在启动时自动迁移受支持的旧 schema。
 * Engine 在 `atomic` 事务内变更领域聚合，而 Source、视图与 Outbox 读取状态或更新各自的记录。
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  /**
   * 打开或创建 `path` 处的 SQLite 数据库，在单个事务中把 schema 10 迁移到 schema 11。
   * @param report - 接收 `afterCommit` 回调抛出的错误，且不会让已提交的事务失败。
   * @throws 当数据库 schema 早于 `OLDEST_SCHEMA`（10）、晚于 `SCHEMA_VERSION`（11），或迁移失败时；这些情况下数据库文件都保持原样，SQLite 句柄被关闭，使同一进程后续的尝试仍能打开它。
   */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.read = storeReads(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = this.get(KV.store.schema)
      if (version !== undefined && version > SCHEMA_VERSION) throw new Error(`不支持的编排器数据库版本 ${version}`)
      if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
      const migrating = version !== undefined && version < SCHEMA_VERSION
      try {
        this.atomic(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
          `)
          this.addColumns()
          if (migrating) migrateTo11(this)
          if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION)
        })
      } catch (error) {
        if (!migrating) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`编排器数据库仍停留在 schema ${version}：迁移到 schema ${SCHEMA_VERSION} 失败：${reason}`, { cause: error })
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** 打开由旧版本创建的数据库时，校正生成的活跃工作集列与索引。 */
  private addColumns(): void {
    const columns = (table: string) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
    for (const [table, definitions] of Object.entries(SETS)) {
      // 先删除定义已变更或已被移除的生成列及其索引，再添加当前列。
      const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
      for (const name of generated) {
        if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      const existing = columns(table)
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
    if (!columns('effect').has('generation')) this.db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  }
  /** 关闭底层 SQLite 数据库连接。 */
  close(): void { this.db.close() }
  /** 解析 `sql` 返回的 JSON `value` 列。 */
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }
  /** 重新索引 Trigger 所属的 thread，替换同一 Trigger 早前保存留下的行。 */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** 等待最外层事务提交后运行的回调，按 savepoint 层级索引；回滚某一层会丢弃该层的回调。 */
  private readonly committed: (() => void)[][] = []
  /**
   * 在 savepoint 事务中执行 `operation`（若已有事务则嵌套其中）；失败会回滚其变更。
   * 提交后回调只在最外层事务提交后运行；回调抛出的错误会被上报，而不会让已提交的事务失败。
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /**
   * 把 `action` 安排在 min 外层事务提交后运行；若不在事务中则立即运行。
   * 在回滚的事务中入队的回调会被丢弃，永不运行。
   * 对已提交写入的即时内存后续操作（例如刷新健康状态或取消内存中的回合）使用 `afterCommit`，它们无法等待 effect 队列，也无需在重启后存活；必须跨越崩溃存活的有副作用操作则使用 `Effects`。
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  /** 按 `KV` 中的 key 读取带类型的 KV 记录。 */
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as V
  }
  /** 在 `name` 下写入带类型的 KV 记录。 */
  set<V>(name: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  /** 删除 `name` 处的 KV 记录。 */
  delete(name: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(name) }
  /** 返回属于 `family` 或以 `prefix` 开头的所有 KV key。 */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
  }

  /** 版本化设置快照；当前设置即最新修订的快照。 */
  private readonly settingsVersions = new Versions<SettingsVersion>(this, KV.settings.revision, KV.settings.version)
  /** 当前已校验的设置。 */
  settings(): Settings { return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {}) }
  /** 某个设置块的修订号；每个配置页针对自己的块保存，以实现乐观并发。 */
  blockRevision(block: SettingsSave): number { return this.get(KV.settings.block(block)) ?? 0 }
  /** 把设置保存为下一个修订（并设为当前），存在时递增 `record.block` 的修订计数。 */
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      return settings
    })
  }
  /** 已保存的设置修订，最新的在前；早于设置历史功能的修订不在其中。 */
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsVersions.list(limit) }

  readonly triggers = {
    get: (id: string): Trigger | undefined => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Trigger : undefined },
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
    }),
    disposition: (id: string): TriggerDisposition | undefined => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as TriggerDisposition : undefined },
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? JSON.parse(String(row.value)) as Thread : undefined },
    save: (thread: Thread): void => { this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread)) },
    list: (): Thread[] => this.db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** 更新面向人的 thread 元数据（`label`、`url` 与 `facts`，其中 `null` 表示按 ID 移除某条 fact）；thread 不存在时为空操作。 */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** 重新读取 thread 之后，原子地设置或移除（`undefined`）其 Source 专属元数据键；thread 不存在时为空操作。 */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Ticket : undefined },
    save: (ticket: Ticket): void => { this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket)) },
    /** 最新的在前。 */
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** 最新的在前。 */
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** 最新的在前。 */
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Decision : undefined },
    save: (decision: Decision): void => { this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision)) },
    byThread: (threadKeyValue: string): Decision[] => this.db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid').all(threadKeyValue).map(row => JSON.parse(String(row.value)) as Decision),
  }
  /** 供管理视图、orchestrator 工具与 Source 轮询使用的只读查询（见 `storeReads`）。 */
  readonly read: ReturnType<typeof storeReads>

  /** 已入队消息的投递状态；回执永久保留，使消息 ID 具备幂等性。 */
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
  /** 渠道投递的 outbox 消息回执；只有 `Outbox` 会写入 `receipts`。 */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** 待投递消息回执，最早的在前。 */
    waiting: (): Receipt[] => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** 当同一工单、同一会话中较早的消息仍在待投递，且其连续失败的 `reply` effect 尝试少于 `failures` 次时为 true。 */
    behind: (id: string, failures: number): boolean => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    /**
     * 记录一条新的待投递消息回执；已记录的消息 ID 保留其原始回执。
     * @returns 该消息 ID 是否为新记录。
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0
    },
    /**
     * 把待投递回执标记为已发送或已丢弃（附丢弃原因与时间戳）；若消息在发送过程中被撤回，则重建回执，
     * 使其 ID 无法再次入队。
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes)) this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * 撤回一条尚未发送的待投递消息。
     * @returns 是否存在 `id` 的待投递消息被移除。
     */
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
export { key, threadKey }
export type { ChannelRef }

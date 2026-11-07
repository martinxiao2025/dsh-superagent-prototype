/** 供视图、工具与 Source 轮询使用的只读 Store 查询。 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Decision, Thread, Trigger } from '../core/index.ts'
import type { Dropped, Receipt, TimelinePlace } from './store.ts'

export function storeReads(db: DatabaseSync) {
  const values = <T>(sql: string, ...parameters: SQLInputValue[]): T[] => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  return {
  /** 按到达（`rowid`）顺序而非 trigger 时间戳排序，最新的在前。 */
  recentTriggers: (offset = 0, limit = 50): Trigger[] => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Trigger),
  /** 自 `since` 起按 Source 统计的 trigger 数，以及全时段内最新的到达时间戳。 */
  triggerStats: (since: string): Record<string, { received: number; filtered: number; lastAt: string }> => {
    const result: Record<string, { received: number; filtered: number; lastAt: string }> = {}
    for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
      result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') }
    return result
  },
  /**
   * 统计自 `since` 起到达、通过 Source 过滤并进入决策的 trigger 数，
   * 以及这些到达共产生了多少 accept/reopen 决策。
   */
  flow: (since: string): { judged: number; accepted: number } => {
    const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)"
    const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since)
    const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since)
    return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) }
  },
  triggers: (options: { source?: string; filtered?: boolean }, offset = 0, limit = 50): { items: Trigger[]; more: boolean } => {
    const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])]
    const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Trigger), more: rows.length > limit }
  },
  /** 返回 thread 上最新的 `limit` 条 trigger，按从旧到新排列；可选地限定在 `before` 之前（或包含 `before`）。 */
  threadTriggers: (threadKeyValue: string, limit = 50, before?: TimelinePlace, through = false): Trigger[] => {
    const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : ''
    return values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse()
  },
  threadPage: (threadKeyValue: string, offset: number, limit: number): Trigger[] => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
  /** thread 上紧邻 `(at, id)` 前后的最近非 CI trigger。 */
  neighbours: (threadKeyValue: string, at: string, id: string): { before?: Trigger; after?: Trigger } => {
    const nearest = (side: '<' | '>') => values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0]
    const before = nearest('<'), after = nearest('>')
    return { ...before ? { before } : {}, ...after ? { after } : {} }
  },
  /** thread 上最早的 trigger，用于在列表中命名该 thread。 */
  firstTrigger: (threadKeyValue: string, humanOnly = false): Trigger | undefined => {
    const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue)
    return row ? JSON.parse(String(row.value)) as Trigger : undefined
  },
  search: (query: string, limit = 20): Trigger[] => {
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)) as Trigger)
  },
  /** 尚未产生 disposition（即还没被决策或过滤）的 Trigger 数，供工具结果尾部的未读摘要使用。 */
  undecided: (): number => Number(db.prepare('SELECT COUNT(*) AS n FROM trigger t LEFT JOIN disposition d ON d.id = t.id WHERE d.id IS NULL').get()?.n ?? 0),
  recentDecisions: (offset = 0, limit = 50): Decision[] => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Decision),
  /** kind 匹配 `kinds`、且其 trigger 自 `since` 起到达的决策，与 `flow` 的窗口计数口径一致。 */
  decisions: (options: { kinds: string[]; since: string }, offset: number, limit: number): { items: Decision[]; more: boolean } => {
    const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
      ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])]
    const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
      .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Decision), more: rows.length > limit }
  },
  /** 给定 kind 的最新决策，供需要在大量忽略中呈现罕见结果的界面使用。 */
  decisionsOfKinds: (kinds: string[], limit = 30): Decision[] => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value)) as Decision),
  /** `reply` effect 失败的消息，附连续失败次数与最后一次错误，按从旧到新排列。 */
  failingReplies: (): (Receipt & { attempts: number; error: string })[] => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all()
    .map(row => ({ ...JSON.parse(String(row.value)) as Receipt, attempts: Number(row.attempts), error: String(row.error) })),
  droppedReplies: (limit = 20): Dropped[] =>
    values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
  droppedSince: (since: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
  subscribedThreads: (source?: string): Thread[] => source
    ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
    // 强制使用部分索引，避免 SQLite 按 rowid 顺序全表扫描。
    : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
  }
}

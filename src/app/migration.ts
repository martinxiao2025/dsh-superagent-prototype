/**
 * 在单个事务内把 schema 10 数据库迁移到 schema 11，使运行时读取方永远不需要转换旧形态。
 * 比 schema 10 更旧的数据库会被拒绝：本版本无法迁移它们。
 */
import { basename } from 'node:path'
import { z } from 'zod'
import { isoTime, said, type AcceptMode, type AdmissionCell, type ChannelRef, type Decision, type Execution, type Follow, type MandateBasis,
  type Reason, type Thread, type Ticket, type TicketInput, type TriggerDisposition } from '../core/index.ts'
import { feishuChatLink } from '../sources/feishu-channel.ts'
import { POLL_HORIZON_MS } from '../sources/poll.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../policy.ts'
import { autoMergeThreshold, teamDefaults } from './context.ts'
import { PromptConfigSchema, type PromptConfig, type PromptVersion } from './prompts.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'
import { promptsNotice, settingsNotice, subscriptionNotice } from './notices.ts'
import type { SettingsVersion, Store } from './store.ts'
import { Versions } from './versions.ts'
import { KV, type Key } from '../kv.ts'

export const SCHEMA_VERSION = 11
/** 本构建可以直接打开并迁移的最旧数据库 schema 版本。 */
export const OLDEST_SCHEMA = 10
/** 返回解释 `version` 为何无法打开的错误消息：更旧的 schema 需要新的状态目录。 */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`

type Stored = Record<string, unknown>
const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** 运行一个迁移步骤，给抛出的错误加上失败记录名称的前缀。 */
function step<T>(record: string, work: () => T): T {
  try { return work() } catch (error) { throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
/** 就地把所有 schema 10 记录改写为 schema 11 的形态。 */
export function migrateTo11(store: Store): void {
  step('the settings', () => { migrateSettingsRecords(store) })
  step('the prompt versions', () => { migratePrompts(store) })
  const answers = new Map<string, string[]>()
  for (const name of store.keys('answer-ready:')) {
    const [, ticketId, triggerId] = name.split(':')
    if (store.get(name) === true && ticketId && triggerId) answers.set(ticketId, [...answers.get(ticketId) ?? [], triggerId])
  }
  const human = (triggerId: string) => store.triggers.get(triggerId)?.human === true
  const closed = (number: number) => pullEnd(store.get<unknown>(`github-ended:${number}`))
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(ticketOf(JSON.parse(String(row.value)) as Stored, answers, human, closed)) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM decision WHERE json_type(value, '$.mandate') = 'object'").all()) {
    step(`decision ${String(row.id)}`, () => {
      const decision = JSON.parse(String(row.value)) as Decision
      store.decisions.save({ ...decision, mandate: { ...decision.mandate!, basis: basisOf(decision.mandate!.basis as unknown) } })
    })
  }
  for (const thread of store.threads.list()) {
    const evaluating = thread.evaluating
    if (evaluating) step(`thread ${thread.key}`, () => { store.threads.save({ ...thread, evaluating: { ...evaluating, basis: basisOf(evaluating.basis as unknown) } }) })
  }
  step('the Threads\' activity times', () => { backfillThreadTimes(store) })
  // 执行器可读的输入键现在以 `ticket/` 而不是 `task/` 为前缀；保留已写在 `ticket/` 下的键。
  for (const name of store.keys('task/')) {
    const renamed = `ticket/${name.slice('task/'.length)}`
    if (store.get(renamed) === undefined) store.set(renamed, store.get(name))
    store.delete(name)
  }
  for (const name of DEAD_KEYS.flatMap(prefix => prefix.endsWith(':') ? store.keys(prefix) : [prefix])) store.delete(name)
  // Source 读取页、提示词预览与飞书消息链接现在缓存于内存而非 SQLite。
  store.db.exec(`DELETE FROM kv WHERE key LIKE 'feishu-read:%' OR key LIKE 'github-read:%' OR key LIKE 'feishu-source-link:%'
    OR key LIKE '%:prompt-preview/%'`)
  queueEarlierWork(store)
  // 把丢弃消息的散文式原因转换为面板本地化的原因代码。
  store.db.exec(`UPDATE outbox SET value = json_set(value, '$.dropped.reason', CASE value ->> '$.dropped.reason'
    WHEN 'The conversation can no longer receive messages' THEN 'channelGone'
    WHEN 'The Source no longer listens to this conversation' THEN 'channelIgnored'
    ELSE value ->> '$.dropped.reason' END) WHERE value -> '$.dropped' IS NOT NULL`)
  step('the outbox', () => { outboxReceipts(store) })
  step('the current settings', () => { settingsAsVersions(store) })
  // Sessions 把每个 Session 运行用过的提示词修订持久化在 `KV.sessions.prompts`（`session-prompts:`）中，用于授权读取；删除旧的 `prompt-version-read:` 标记。
  store.db.exec("DELETE FROM kv WHERE key LIKE 'prompt-version-read:%'")
  // schema 6 的表保持原位：schema 7 导入过它们，但没有导入每一行。
  step('the Sources\' records', () => { migrateSourceRecords(store) })
  // 执行器 Session 现在直接从工单记录渲染输入，因此独立的输入正文键已废弃。
  step('the Inputs\' bodies', () => { store.db.exec("DELETE FROM kv WHERE key LIKE 'ticket/%/input/%'") })
  step('the pull request ends', () => { dropPullEnds(store) })
  step('the dismissed problems', () => { moveDismissals(store) })
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(withoutCopies(JSON.parse(String(row.value)) as Stored)) })
  }
  step('the reasons', () => { reasonsAsCodes(store) })
  step('the Triggers\' times', () => { triggerTimes(store) })
}
/**
 * 把触发与线程时间戳规范化为定宽的毫秒级 ISO 字符串，使字典序与时间顺序一致
 * （GitHub 曾写整秒如 `…:00Z`，它会排在 `…:00.001Z` 之后）。
 */
function triggerTimes(store: Store): void {
  for (const row of store.db.prepare('SELECT id, at FROM trigger').all()) {
    const at = isoTime(String(row.at))
    if (at !== row.at) store.db.prepare("UPDATE trigger SET at = ?, value = json_set(value, '$.at', ?) WHERE id = ?").run(at, at, String(row.id))
  }
  store.db.exec(`UPDATE trigger_thread SET at = (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)
    WHERE at <> (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)`)
  for (const thread of store.threads.list()) {
    const createdAt = isoTime(thread.createdAt), lastAt = thread.lastAt === undefined ? undefined : isoTime(thread.lastAt)
    if (createdAt === thread.createdAt && lastAt === thread.lastAt) continue
    store.threads.save({ ...thread, createdAt, ...lastAt === undefined ? {} : { lastAt } })
  }
}
/**
 * 已废弃的 KV 键与前缀（以 `:` 结尾），来自已移除的 `github-issue` 资格检查、更早的迁移，
 * 以及 schema 11 之前的维护与订阅跟踪。
 */
const DEAD_KEYS = ['github-object-state:', 'github-issue-eligibility:', 'github-auto-merge:',
  'source-labels-at:', 'legacy-migrated-at', 'thread-times-backfilled', 'settings-before-9', 'answer-ready:', 'prompt-sections', 'prompt-settings-text',
  'prompt-vocabulary', 'subscriptions', 'subscriptions-initialized', 'subscription-seen:', 'subscription-initialized:', 'subscription-since:',
  'observation-since:', 'task-threads:', 'maintenance-recovery:', 'maintenance-progress-report-recovery:', 'maintenance-thread-followup:',
  'master-recovery:', 'github-issue-candidates']

/**
 * 按顺序把旧的主 session 队列移入统一 effect 队列（先转向中继，再是移除订阅、已保存提示词与已保存设置的通知），
 * 然后删除旧键。
 */
function queueEarlierWork(store: Store): void {
  const queue = effectQueue(store)
  const { relays, unsubscribed, prompts, settings } = KV.queues
  for (const { id, text } of store.get(relays) ?? []) queue('relay', id, { text })
  const prompt = store.get(prompts), saved = store.get(settings)
  const notices = [...(store.get(unsubscribed) ?? []).map(thread => subscriptionNotice(thread)),
    ...prompt == null ? [] : [promptsNotice(prompt)], ...saved == null ? [] : [settingsNotice()]]
  for (const [name, value, summary] of notices) queue('notice', name, { value, summary })
  for (const name of [relays, unsubscribed, prompts, settings]) store.delete(name)
}

/**
 * 在 `Effects` 尚不存在的迁移期间直接把 effect 插入数据库，保留先前的失败计数；
 * 与 `Effects.enqueue`（会 upsert 负载、递增 generation 并重置 attempts）不同，`INSERT OR IGNORE`
 * 不会改动该 `kind` 与 `key` 已排队的行。
 */
function effectQueue(store: Store) {
  let seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  return <K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K], failed = { attempts: 0, error: '' }) =>
    store.db.prepare('INSERT OR IGNORE INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, key, JSON.stringify(payload), ++seq, failed.attempts, failed.error, Date.now(), new Date().toISOString())
}
/**
 * 把发件箱行转换为状态回执（`pending`、`sent` 或 `dropped`），并按行序把待发消息作为 `reply`
 * effect 入队，把其先前的 `attempts` 与 `error` 移到该 effect 上。
 */
function outboxReceipts(store: Store): void {
  const columns = store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => String(row.name))
  if (!columns.includes('sent')) return
  const queue = effectQueue(store)
  for (const row of store.db.prepare('SELECT id, value, sent FROM outbox ORDER BY rowid').all()) {
    const { attempts, error, nextAttemptAt: _next, ...message } = JSON.parse(String(row.value)) as Stored
    const status = message.dropped ? 'dropped' : row.sent ? 'sent' : 'pending'
    store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(JSON.stringify({ ...message, status }), String(row.id))
    if (status === 'pending') queue('reply', String(row.id), {}, { attempts: Number(attempts ?? 0) || 0, error: typeof error === 'string' ? error : '' })
  }
  store.db.exec('DROP INDEX IF EXISTS outbox_waiting; ALTER TABLE outbox DROP COLUMN sent')
}

/**
 * 确保最新的设置修订快照持有当前设置（若缺失或更早的迁移步骤剥离了已移除的 Source 则保存新修订），
 * 然后删除独立的 `settings` 键。
 */
function settingsAsVersions(store: Store): void {
  const current = store.get<unknown>('settings')
  if (current === undefined) return
  const versions = new Versions<SettingsVersion>(store, KV.settings.revision, KV.settings.version)
  const newest = Math.max(versions.revision(), ...versions.list().map(version => version.revision))
  if (newest) store.set(KV.settings.revision, newest)
  if (JSON.stringify(versions.current()?.settings) !== JSON.stringify(current)) {
    const settings = SettingsSchema.parse(current)
    versions.save(revision => ({ revision, savedAt: new Date().toISOString(), source: 'internal', policyVersion: policyVersion(settings),
      policyChanged: false, notified: [], settings }))
  }
  store.delete('settings')
}

/** schema 11 之前的版本记录的设置保存来源名，映射到当前的 `SettingsOrigin` 值。 */
const ORIGINS: Readonly<Record<string, SettingsOrigin>> = { web: 'panel', 'orchestrator-tool': 'tool', 'policy-sync': 'sync', 'member-sync': 'sync' }
/** 已从 dsh-superagent-cn 移除的 Source kind；统一的 `github` Source 现在经通知摄取 Issue。 */
const REMOVED_SOURCES: readonly string[] = ['github-issue']
/**
 * 把当前与历史设置记录升级到 schema 11 结构：从活跃设置中剥离已移除的 Source kind，
 * 同时在历史修订中保留它们，并映射历史来源名。
 */
function migrateSettingsRecords(store: Store): void {
  const stored = store.get<unknown>('settings')
  if (stored !== undefined) {
    const settings = SettingsSchema.parse(migrateSettings(stored))
    store.set('settings', { ...settings, sources: Object.fromEntries(Object.entries(settings.sources).filter(([id]) => !REMOVED_SOURCES.includes(id))) })
  }
  // 原样保留无法解析的历史修订，使损坏的历史条目不会阻塞启动。
  for (const name of store.keys('settings-version:')) {
    const version = store.get<{ source: string; settings: unknown }>(name)!
    const settings = SettingsSchema.safeParse(migrateSettings(version.settings))
    store.set(name, { ...version, source: ORIGINS[version.source] ?? version.source, ...settings.success ? { settings: settings.data } : {} })
  }
}
interface Member { name?: string; feishuId?: string; github?: string }
/**
 * 把旧式扁平设置（Policy 中的会话列表、顶层的暂停标志）或 schema 11 之前的领域设置转换为当前的领域块：
 * 剥离被规则指令与提示词取代的字段（执行器 reviewer 与分支前缀、规则的 `visual` 标志、`autoMergeLineLimit`、
 * Source 的 `authority`、GitHub 的 `mergeCli`），把 `paused` 提取到顶层，并把跨 Source 的 `members`
 * 拆分为每个 Source 的 `policy.sources` 条目。
 */
export function migrateSettings(value: unknown): unknown {
  if (!isObject(value)) return value
  if (!('members' in value || 'allowedChats' in value || 'admission' in value)) return withoutRemovedFields(value)
  const old = value as { models?: { orchestrator?: unknown; worker?: unknown }; paused?: boolean; allowedChats?: string[]; members?: unknown[];
    allowDirectMessages?: boolean; pollSeconds?: number; maxWorkers?: number; admission?: { mode?: string; chats?: string[]; timeoutSeconds?: number; rules?: unknown[] } }
  const chats = new Map<string, 'mentions' | 'all'>()
  for (const chatId of old.allowedChats ?? []) chats.set(chatId, 'mentions')
  // 只有准入启用时，观察中的会话才是活跃的。
  if (old.admission?.mode !== 'off') for (const chatId of old.admission?.chats ?? []) chats.set(chatId, 'all')
  const feishu = { chats: [...chats].map(([chatId, listen]) => ({ chatId, listen })), directMessages: old.allowDirectMessages ?? true }
  return withoutRemovedFields({
    sources: { feishu: { enabled: true, config: feishu }, github: { enabled: true, config: { pollSeconds: old.pollSeconds ?? 60 } } },
    policy: { ...(old.members ? { members: old.members } : {}), ...(old.admission?.rules ? { rules: old.admission.rules } : {}) },
    eval: { ...(old.admission?.mode ? { mode: old.admission.mode } : {}), ...(old.admission?.timeoutSeconds ? { timeoutSeconds: old.admission.timeoutSeconds } : {}),
      model: old.models?.orchestrator ?? null },
    executor: { model: old.models?.worker ?? null, ...(old.maxWorkers ? { maxWorkers: old.maxWorkers } : {}), paused: old.paused ?? false },
  })
}
function withoutRemovedFields(value: Stored): Stored {
  const { executor, policy, sources, ...rest } = value as { executor?: Stored; policy?: Stored; sources?: Record<string, Stored> }
  // `paused` 现在是顶层设置，而不是 `executor` 上的字段。
  const { reviewer: _reviewer, visualReviewer: _visualReviewer, branchPrefix: _branchPrefix, paused, ...kept } = executor ?? {}
  const { members, memberChat, autoMergeLineLimit: _limit, rules: storedRules, ...policyRest } = policy ?? {}
  const rules = Array.isArray(storedRules) ? storedRules.map((rule: unknown) => { if (!isObject(rule)) return rule; const { visual: _visual, ...fields } = rule; return fields })
    : storedRules
  const people = Array.isArray(members) ? members as Member[] : undefined
  const parts = people ? {
    feishu: { allowed: people.filter(member => member.feishuId).map(member => ({ id: member.feishuId!, ...(member.name ? { name: member.name } : {}) })),
      ...(memberChat ? { syncChat: memberChat } : {}) },
    github: { allowed: people.filter(member => member.github).map(member => ({ id: member.github! })) },
  } : undefined
  // GitHub Source 不再配置专用的合并账号；自动合并策略现在保存在提示词中。
  const withoutMerge = (id: string, config: unknown) => { if (id !== 'github' || !isObject(config)) return config; const { mergeCli: _mergeCli, ...fields } = config; return fields }
  const instances = sources ? Object.fromEntries(Object.entries(sources).map(([id, instance]) => {
    const { authority: _authority, ...fields } = instance
    return [id, 'config' in fields ? { ...fields, config: withoutMerge(id, fields.config) } : fields]
  })) : undefined
  // 在 `prepare` 命令中，把项目旧名称的环境变量前缀改写为新名称。
  if (typeof kept.prepare === 'string') kept.prepare = kept.prepare.replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  return { ...rest, ...(typeof paused === 'boolean' ? { paused } : {}), ...(executor ? { executor: kept } : {}),
    ...(instances ? { sources: instances } : {}),
    ...(policy ? { policy: { ...policyRest, ...(rules ? { rules } : {}), ...(parts ? { sources: parts } : {}) } } : {}) }
}

/** 团队段落出现之前保存的提示词配置形态，当时所有段落（包括固定段落）都可编辑。 */
const LegacyPromptConfigSchema = z.object({ shared: z.string(), orchestrator: z.string(), worker: z.string(), guides: z.record(z.string(), z.string()) })
/** 旧提示词配置中的 guide 名称，它们现在是固定的内置提示词段落或技能。 */
const LEGACY_FIXED = new Set(['cli', 'subscriptions', 'replies', 'reviews', 'dispatch', 'work', 'feishu', 'github'])
/** 领域词汇重命名之前已保存提示词中使用的工具名，与其现在的替代成对。 */
const RENAMED_TOOLS: readonly (readonly [string, string])[] = [
  ['orchestrator_subscription_remove', 'orchestrator_thread_unsubscribe'], ['orchestrator_subscriptions', 'orchestrator_threads'],
  ['orchestrator_create_task', 'orchestrator_route (kind accept)'], ['orchestrator_send_task', 'orchestrator_route (kind attach)'],
  ['orchestrator_reopen_task', 'orchestrator_route (kind attach)'], ['orchestrator_ticket_reopen', 'orchestrator_route (kind attach)'],
  ['orchestrator_stop_task', 'orchestrator_route (kind stop)'], ['orchestrator_ignore_event', 'orchestrator_route (kind ignore)'],
  ['orchestrator_request_status', 'orchestrator_ticket_request_status'], ['orchestrator_inspect_task', 'orchestrator_ticket_inspect'],
  ['orchestrator_observations', 'orchestrator_decisions'], ['orchestrator_event_replay', 'orchestrator_trigger_requeue'],
  ['orchestrator_tasks', 'orchestrator_tickets'], ['orchestrator_assess', 'orchestrator_eval'], ['admission_read', 'orchestrator_eval_read'],
  ['admission_decide', 'orchestrator_eval_decide'],
]
/** 被 `orchestrator_read <resource>` 取代的只读工具，映射到其资源路径。 */
const READ_TOOLS: Readonly<Record<string, string>> = { orchestrator_tickets: 'tickets', orchestrator_threads: 'threads', orchestrator_decisions: 'decisions',
  orchestrator_settings_read: 'settings', orchestrator_prompts_read: 'prompts', orchestrator_models: 'models', orchestrator_ticket_inspect: 'ticket/<id>' }
/**
 * 把技能与变量前缀从项目旧名称（`dsh-tag`、`dsh-go`、`dsh-freelancer` 以及之前的
 * `dsh-superagent`）改写过来，用 `orchestrator_read` 替换已退役的只读工具，
 * 并用 `orchestrator_route` 及其 kind 替换四个路由工具。
 */
const currentNames = (value: string): string => value.replace(/\bdsh-(?:tag|go|freelancer)-/g, 'dsh-superagent-cn-').replace(/\bdsh-superagent-(?!cn)/g, 'dsh-superagent-cn-')
  .replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  .replace(/\borchestrator_(?:tickets|threads|decisions|settings_read|prompts_read|models|ticket_inspect)\b/g, name => `orchestrator_read ${READ_TOOLS[name]}`)
  .replace(/\borchestrator_(?:ticket_(accept|attach|stop)|trigger_(ignore))\b/g, (_name, ticket?: string, trigger?: string) =>
    `orchestrator_route (kind ${ticket ?? trigger ?? ''})`)
/** 把旧技能正文改写为当前的工具、参数、资源、段落、技能与变量名。 */
function legacyText(value: string): string {
  let result = value
  for (const [from, to] of RENAMED_TOOLS) result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  return currentNames(result.replaceAll('reply_to_event_id', 'reply_to_trigger_id').replace(/\bevent_id\b/g, 'trigger_id').replace(/\btask_id\b/g, 'ticket_id')
    .replaceAll('related_tasks', 'related_tickets').replace(/(?<![\w/-])event\//g, 'trigger/').replace(/(?<![\w/-])task\//g, 'ticket/').replaceAll('<event-id>', '<trigger-id>')
    .replace(/\bguide\/([a-z][a-z0-9-]*)\b/g, (_match, name: string) => LEGACY_FIXED.has(name) ? `the ${name} section` : `skill dsh-superagent-cn-${name}`))
}
/**
 * 把已存储的提示词配置升级到当前的段落、工具名与技能引用；旧配置采用内置团队段落，
 * 把自定义 guide 保留为技能，并把自动合并行数阈值带入 `delivery`。
 */
function normalize(config: unknown): PromptConfig {
  const legacy = LegacyPromptConfigSchema.safeParse(config)
  const limit = legacy.success ? /fewer than (\d+) lines \(additions plus deletions\)/.exec(legacy.data.guides.work ?? '')?.[1] : undefined
  const current = legacy.success ? { ...teamDefaults, delivery: limit ? teamDefaults.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(Number(limit))) : teamDefaults.delivery,
    skills: Object.fromEntries(Object.entries(legacy.data.guides).filter(([name]) => !LEGACY_FIXED.has(name)).map(([name, body]) => [name, legacyText(body)])) }
    : PromptConfigSchema.parse(config)
  return { communication: currentNames(current.communication), scope: currentNames(current.scope), delivery: currentNames(current.delivery),
    skills: Object.fromEntries(Object.entries(current.skills).map(([name, body]) => [name, currentNames(body)])) }
}
/**
 * 把已存储的提示词修订规范化到当前段落与名称（在团队段落出现之前保存或无法解析时，把原始配置记录在
 * `legacy` 下），并为已移除的设置字段（自动合并阈值与跨 Source 成员身份）合成一个新修订，
 * 除非更早的迁移已经创建。
 */
function migratePrompts(store: Store): void {
  // 在旧式或无法解析的修订上保留原始配置，回退到最后一个可读的配置，使 session 始终有有效的提示词。
  const versions = store.keys('prompt-version:').map(name => store.get<PromptVersion & { config: unknown }>(name)!).sort((a, b) => a.revision - b.revision)
  let readable: PromptConfig = { ...teamDefaults, skills: {} }
  for (const version of versions) {
    const legacy = LegacyPromptConfigSchema.safeParse(version.config).success
    let config: PromptConfig
    try { config = normalize(version.config) } catch { config = readable }
    const kept = legacy || config === readable ? { legacy: version.legacy ?? { config: version.config } } : {}
    store.set(`prompt-version:${version.revision}`, { ...version, config, ...kept })
    readable = config
  }
  if (store.get('prompt-settings-text') === 1) return
  const before = store.get<unknown>('settings-before-9')
  const policy = (isObject(before) ? before.policy : undefined) as { autoMergeLineLimit?: unknown; members?: unknown } | undefined
  const limit = typeof policy?.autoMergeLineLimit === 'number' ? policy.autoMergeLineLimit : 200
  const mapped = ((Array.isArray(policy?.members) ? policy.members : []) as Member[]).filter(person => person.feishuId && person.github)
  const revision = store.get<number>('prompt-revision')
  const current = revision === undefined ? undefined : store.get<PromptVersion>(`prompt-version:${revision}`)
  const config = current?.config ?? { ...teamDefaults, skills: {} }
  const delivery = config.delivery.includes(autoMergeThreshold(200)) ? config.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(limit))
    : limit === 200 ? config.delivery : `${config.delivery}\n仅对改动少于 ${limit} 行（新增加删除）的 PR 开启自动合并。`
  const identities = mapped.length && !config.skills.identities ? { identities: ['同一位同事在不同 Source 上可能使用不同账号。当你提及、指派或请求评审一位你在其他 Source 上认识的人时，使用其在本 Source 上的账号：',
    ...mapped.map(person => `- ${person.name ?? person.feishuId}（飞书 ${person.feishuId}）在 GitHub 上是 @${person.github}`)].join('\n') } : {}
  const next = { ...config, delivery, skills: { ...config.skills, ...identities } }
  if (JSON.stringify(next) === JSON.stringify(config)) return
  const previous = current?.revision ?? 0
  if (!current) store.set('prompt-version:0', { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config })
  store.set(`prompt-version:${previous + 1}`, { revision: previous + 1, previousRevision: previous, savedAt: new Date().toISOString(), source: 'settings-migration', config: next })
  store.set('prompt-revision', previous + 1)
}

const CELLS: readonly string[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
/**
 * 把旧式授权依据对象升级到当前的标签联合形态。
 * 当前依据记录 `source` 与 `scope`；更旧的直接记录飞书会话（`chatId`）或 schema 6 的 `legacyAuthority`。
 * 既无准入表单元格也无 `followup` 的依据来自在列发送者（记录了 `addressed`、`sender` 与 `source` 时为
 * `addressed`，否则为 `listed`），只要发送者仍在列即成立。
 */
export function basisOf(stored: unknown): MandateBasis {
  // 缺失或非对象的依据默认为在列发送者依据（`via: 'listed'`）。
  const old = isObject(stored) ? stored : {}
  if (typeof old.via === 'string') return old as unknown as MandateBasis
  // 更旧的飞书依据在顶层而非 `scope` 内记录 `chatId` 与 `direct`。
  const chat = text(old.chatId) ? { source: 'feishu', scope: { chatId: old.chatId, direct: old.direct === true } } : {}
  const received = text(old.source) ? { source: old.source as string, ...isObject(old.scope) ? { scope: old.scope } : {}, ...text(old.row) ? { row: old.row as string } : {} } : chat
  const sender = text(old.sender) ?? text(old.member)
  const common = { ...received, ...sender ? { sender } : {}, ...Array.isArray(old.rules) ? { rules: old.rules as string[] } : {} }
  const addressed = old.addressed === 'mention' || old.addressed === 'direct' ? old.addressed
    : old.direct === true ? 'direct' as const : old.mention === true ? 'mention' as const : undefined
  const mode = text(old.mode) as AcceptMode | undefined
  // schema 6 导入记录了 `legacyAuthority`。
  const authority = text(old.legacyAuthority) ? { authority: old.legacyAuthority as string } : {}
  if (old.followup === true) return { via: 'followup', ...common, ...authority }
  if (CELLS.includes(String(old.admission))) {
    return { via: 'admission', ...common, cell: old.admission as AdmissionCell, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: { mode: mode ?? 'auto' } } : {} }
  }
  if (addressed && sender && text(old.source)) return { via: 'addressed', ...common, addressed }
  // 既无表单元格也无 `followup` 的依据都来自在列发送者。
  return { via: 'listed', ...common, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: mode ? { mode } : {} } : {}, ...authority }
}
/**
 * 把 schema 10 工单记录升级到 schema 11：从 `meta` 与 GitHub opener 渠道提取 `origin`、`execution`、`delivery`
 * 与关注的 PR 线程（`follows`），合并已上报的 `answers`，标记人工触发输入（`human: true`），
 * 并把待处理的 `reopen` 输入转换为给执行器的 `text` 输入。
 */
export function ticketOf(old: Stored, answers = new Map<string, string[]>(), human: (triggerId: string) => boolean = () => false,
  closed: (number: number) => Follow['closed'] = () => undefined): Ticket {
  const { meta: storedMeta, ...rest } = old as Stored & { meta?: Stored }
  const ticket = rest as unknown as Ticket
  const meta = storedMeta ?? {}
  const triggerId = text(meta.sourceTriggerId) ?? ''
  const triggerIds = Array.isArray(meta.triggerIds) ? meta.triggerIds as string[] : triggerId ? [triggerId] : []
  const directory = text(meta.workspace)
  // 其余 `meta` 字段已废弃：schema 6 的任务状态留在 `task` 表中，accept 字段保存在 `execution` 与 `mandate` 上。
  const execution: Execution | undefined = directory ? { name: text(meta.name) ?? basename(directory), directory,
    assignment: text(meta.assignment) ?? text(meta.legacyPrompt) ?? '' } : undefined
  const inputs = ticket.inputs.map((input): TicketInput => input.kind === 'trigger' ? { ...input, ...human(input.triggerId) ? { human: true } : {} }
    : input.kind !== 'reopen' || !ticket.undelivered.includes(input.id) ? input
    : { id: input.id, kind: 'text', at: input.at, text: JSON.stringify({ resumed: true, decision_id: input.decisionId, read: `ticket/${ticket.id}/assignment`,
      note: 'This ticket ended earlier and a follow-up resumed it under the same mandate. Inspect the worktree, git history and PR state before continuing; do not repeat completed external operations.' }) })
  const reported = [...new Set([...ticket.answers ?? [], ...answers.get(ticket.id) ?? []])]
  const ended = ticket.ended && { ...ticket.ended, outcome: ticket.ended.outcome ?? outcomeOf(ticket.ended) }
  const mandate = { ...ticket.mandate, basis: basisOf(ticket.mandate.basis as unknown) }
  const delivery = ticket.delivery ?? (text(meta.deliveryError) ? { error: meta.deliveryError as string, at: ticket.updatedAt } : undefined)
  const kept = execution ?? ticket.execution
  const follows = ticket.follows ?? followsOf(meta, ticket.channels, closed)
  return { ...ticket, inputs, ...ended ? { ended } : {}, mandate, origin: ticket.origin ?? { triggerId, triggerIds },
    // 被人停止的工单不再接收工作，因此清空所有未送达的输入。
    ...ended?.by === 'human' ? { undelivered: [] } : {},
    ...kept ? { execution: kept } : {}, ...delivery ? { delivery } : {},
    channels: ticket.channels.filter(channel => !opener(channel)), ...follows.length ? { follows } : {},
    ...reported.length ? { answers: reported } : {} }
}
/** schema 10 把工单打开的 PR 记录为没有评论 URL（`address.url`）的 GitHub 渠道。 */
const opener = (channel: ChannelRef): boolean => channel.source === 'github' && !channel.address.url && !!Number(channel.address.number)
/**
 * 从旧工单元数据重建关注的 PR 线程（`meta.prNumber` 排在最后，位于经 GitHub opener 渠道打开的 PR 之后），
 * 把打开的 PR 标记为 `own: true`，并附加已记录的关闭结果。
 */
function followsOf(meta: Stored, channels: ChannelRef[], closed: (number: number) => Follow['closed']): Follow[] {
  const opened = channels.filter(opener).map(channel => Number(channel.address.number))
  const bound = typeof meta.prNumber === 'number' ? [meta.prNumber] : []
  return [...new Set([...opened.filter(number => !bound.includes(number)), ...bound])].map(number => {
    const end = closed(number)
    return { thread: `github:${number}`, own: opened.includes(number), ...end ? { closed: end } : {} }
  })
}
/** 有效时把 schema 10 的 `github-ended:<number>` 记录解析为所关注 PR 的 `closed` 状态。 */
function pullEnd(stored: unknown): Follow['closed'] {
  if (!isObject(stored) || typeof stored.at !== 'string' || (stored.reason !== 'merged' && stored.reason !== 'closed')) return undefined
  return { at: stored.at, outcome: stored.reason }
}
/**
 * 去掉旧工单上重复存储的冗余字段：移除 `state`（由 `ended` 推导），在没有派工带报告时把顶层 `summary`
 * 作为 `progress` 报告移到最新派工上，并移除 `execution.session` 与每个派工的 `ticketId` 和 `ref`（由
 * `ticket.id` 推导）。
 */
export function withoutCopies(old: Stored): Ticket {
  const { state, summary, ...ticket } = old as Stored & Ticket & { state?: string; summary?: unknown }
  const assignments = ticket.assignments.map(item => {
    const { ticketId: _ticket, ref: _ref, ...rest } = item as typeof item & { ticketId?: string; ref?: string }
    return rest
  })
  const latest = assignments.at(-1)
  if (latest && typeof summary === 'string' && summary && !assignments.some(item => item.report)) {
    latest.report = { state: 'progress', summary, at: ticket.updatedAt }
  }
  const { session: _session, ...execution } = (ticket.execution ?? {}) as Partial<Execution> & { session?: string }
  // 未结工单没有 `ended` 记录；被标为 `ended` 却没有记录的工单默认为 `closed`。
  const closed = { at: ticket.updatedAt, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }
  const ended = state === 'open' ? undefined : ticket.ended ?? (state === 'ended' ? closed : undefined)
  const { ended: _ended, ...rest } = ticket
  // 仅当 `ended.reason` 与 `ended.outcome` 不同才保留它，并从因该结束而停止的派工中去掉重复的结束原因。
  const { reason, ...end } = ended ?? {} as NonNullable<Ticket['ended']>
  const once = ended && { ...end, ...reason && reason !== ended.outcome ? { reason } : {} } as NonNullable<Ticket['ended']>
  for (const item of assignments) if (ended && item.endedReason === reason && item.endedAt === ended.at) delete item.endedReason
  return { ...rest, ...once ? { ended: once } : {}, assignments, ...ticket.execution ? { execution: execution as Execution } : {} }
}
/** schema 11 之前的版本写下的固定英文原因句子，映射到其当前的原因代码。 */
const SENTENCES: Readonly<Record<string, string>> = {
  'Assessment timed out': 'timeout', 'Assessment interrupted or timed out': 'timeout',
  'Assessment interrupted, timed out or ended without a decision': 'timeout',
  'Policy changed during assessment': 'policyChanged', 'Access or rule version changed': 'policyChanged',
  'No admissible trigger': 'noAdmissible', 'Explicit member request routed by the orchestrator': 'explicitRouted',
  'Explicit request from an allowed sender routed by the orchestrator': 'explicitRouted',
  'Imported from the pre-domain-model task record': 'legacyImport', 'host restarted': 'hostRestarted', 'Human asked to stop': 'humanStop',
  'Forwarded to the existing topic worker': 'forwarded', 'Sender is not an authorized human member': 'senderNotMember',
  'Retried by a person': 'retried', 'Stop target is unknown or already ended': 'stopUnknown',
  'Stop requires an explicit instruction from an authorized member': 'stopNotExplicit',
  'Implementation intent or target direction is not established, or a product/design decision is still required': 'directionUnsettled',
  'No enabled admission rule matched': 'noRuleMatched',
}
/** 当旧原因字符串匹配 `SENTENCES` 中的固定句子、参数化句子（`routed`、`startedTicket`、`observed`）或 snake_case 的准入/来源代码时，把它解析为 `Reason`。 */
function knownReason(text: string): Reason | undefined {
  if (SENTENCES[text]) return { code: SENTENCES[text] }
  const routed = /^Routed to ticket (\S+)$/.exec(text) ?? /^Already accepted as ticket (\S+)$/.exec(text)
  if (routed) return { code: text.startsWith('Routed') ? 'routed' : 'startedTicket', values: { ticket: routed[1]! } }
  const observed = /^Observe mode: would accept \((.*)\)$/s.exec(text)
  if (observed) return { code: 'observed', values: { text: observed[1]! } }
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? { code: text } : undefined
}
/**
 * 把已存储的决定原因解析为结构化的 `Reason` 代码：把以 `; ` 连接的 `<triggerId>: <reason>` 批量
 * 拆分为每个触发的原因，经 `knownReason` 映射已知句子/代码，并用 `said` 包装其他自由格式的研判者或人工文本。
 */
export function reasonsOf(stored: unknown): Reason[] {
  if (Array.isArray(stored)) return stored as Reason[]
  const text = typeof stored === 'string' ? stored : ''
  const parts = text.split('; ').map(part => /^([^:\s]+): (.+)$/s.exec(part))
  if (parts.every(match => match && knownReason(match[2]!))) return parts.map(match => ({ ...knownReason(match![2]!)!, triggerId: match![1]! }))
  return [knownReason(text) ?? said(text)]
}
/** 把已存储的决定、处置与派工结束原因从自由格式字符串转换为原因代码。 */
function reasonsAsCodes(store: Store): void {
  for (const row of store.db.prepare('SELECT value FROM decision').all()) {
    const decision = JSON.parse(String(row.value)) as Decision & { reason: unknown }
    store.decisions.save({ ...decision, reason: reasonsOf(decision.reason) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM disposition WHERE json_type(value, '$.filtered') = 'text'").all()) {
    const disposition = JSON.parse(String(row.value)) as TriggerDisposition & { filtered: string }
    store.triggers.saveDisposition(String(row.id), { ...disposition, filtered: { code: SENTENCES[disposition.filtered] ?? disposition.filtered } })
  }
  for (const ticket of store.tickets.list()) {
    const ended = (reason?: string) => reason && SENTENCES[reason] === 'retried' ? 'retried' : reason && SENTENCES[reason] === 'hostRestarted' ? 'hostRestarted' : reason
    if (!ticket.assignments.some(item => item.endedReason !== ended(item.endedReason))) continue
    const assignments = ticket.assignments.map(item => item.endedReason ? { ...item, endedReason: ended(item.endedReason) } : item)
    store.tickets.save({ ...ticket, assignments })
  }
}
/** 把 `problem-dismissed:<decisionId>` KV 标志移到对应的 `Decision.dismissed` 字段上，并删除这些 KV 键。 */
function moveDismissals(store: Store): void {
  for (const name of store.keys('problem-dismissed:')) {
    const decision = store.decisions.get(name.slice('problem-dismissed:'.length))
    if (decision && store.get<unknown>(name) === true) store.decisions.save({ ...decision, dismissed: true })
    store.delete(name)
  }
}
/** 在关闭结果已复制到 `Ticket.follows` 之后，删除 `github-ended:<number>` KV 记录。 */
function dropPullEnds(store: Store): void {
  for (const name of store.keys('github-ended:')) store.delete(name)
}
/** 在记录结果出现之前推断工单的 `ended.outcome`（人工停止为 `stopped`，否则匹配 `reason`，默认 `closed`）。 */
function outcomeOf(ended: Pick<NonNullable<Ticket['ended']>, 'by' | 'reason'>): NonNullable<Ticket['ended']>['outcome'] {
  if (ended.by === 'human') return 'stopped'
  return (['completed', 'merged', 'closed', 'dropped'] as const).find(outcome => outcome === ended.reason) ?? 'closed'
}
/** 从最早与最新的触发回填线程的创建与活跃时间戳。 */
function backfillThreadTimes(store: Store): void {
  if (store.get('thread-times-backfilled')) return
  for (const thread of store.threads.list()) {
    const first = store.read.firstTrigger(thread.key), last = store.read.threadTriggers(thread.key, 1)[0]
    if (!first || !last) continue
    const times: Pick<Thread, 'createdAt' | 'lastAt'> = { createdAt: first.at < thread.createdAt ? first.at : thread.createdAt,
      lastAt: !thread.lastAt || last.at > thread.lastAt ? last.at : thread.lastAt }
    store.threads.save({ ...thread, ...times })
  }
}

/** 把已存储的 Source 状态（飞书话题、直聊标志、线程链接、GitHub 游标与待处理评估）升级到 schema 11。 */
function migrateSourceRecords(store: Store): void {
  feishuTopics(store)
  feishuDirectAddresses(store)
  feishuThreadLinks(store)
  issueSourceRecords(store)
  githubCursors(store)
  assessmentTriggers(store)
}
/** 把旧式飞书话题 ID 数组转换为以话题 ID 为键的映射，附该会话最近一次恢复时间戳。 */
function feishuTopics(store: Store): void {
  for (const name of store.keys(KV.feishu.topics)) {
    const topics: unknown = store.get(name)
    if (!Array.isArray(topics)) continue
    const seen = store.get(KV.feishu.history(name.slice(KV.feishu.topics.prefix.length))) ?? new Date().toISOString()
    store.set(name, Object.fromEntries(topics.map(id => [String(id), seen])))
  }
}
/**
 * 从 `KV.feishu.chats` 回填 `direct: 'true'` 到飞书渠道地址，因为飞书的 `oc_` 会话 ID 自身
 * 无法区分私聊与群聊。
 */
function feishuDirectAddresses(store: Store): void {
  const chats = store.get(KV.feishu.chats) ?? {}
  const direct = (channel: unknown): channel is ChannelRef => isObject(channel) && channel.source === 'feishu' && isObject(channel.address)
    && chats[String(channel.address.chatId)] === true && channel.address.direct === undefined
  const marked = (channel: ChannelRef): ChannelRef => direct(channel)
    ? { ...channel, address: { ...channel.address, direct: 'true' } } : channel
  for (const table of ['trigger', 'outbox'] as const) {
    for (const row of store.db.prepare(`SELECT id, value FROM ${table} WHERE value ->> '$.channel.source' = 'feishu'`).all()) {
      const value = JSON.parse(String(row.value)) as Stored
      if (!direct(value.channel)) continue
      const rewritten = JSON.stringify({ ...value, channel: marked(value.channel) })
      store.db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(rewritten, row.id!)
    }
  }
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    const ticket = JSON.parse(String(row.value)) as Ticket
    if (ticket.channels.some(direct)) store.tickets.save({ ...ticket, channels: ticket.channels.map(marked) })
  }
}
/** 为在线程存储自身 URL 之前创建的飞书线程回填会话 URL，依据已有触发 URL 推断品牌。 */
function feishuThreadLinks(store: Store): void {
  const lark = store.db.prepare(`SELECT 1 FROM trigger WHERE value ->> '$.source' = 'feishu'
    AND value ->> '$.url' LIKE '%larksuite.com%' LIMIT 1`).get()
  for (const thread of store.threads.list()) {
    if (thread.ref.source !== 'feishu' || typeof thread.meta.url === 'string' || store.read.firstTrigger(thread.key)?.url) continue
    const chatId = thread.ref.id.split(':')[0]
    if (chatId) store.threads.save({ ...thread, meta: { ...thread.meta, url: feishuChatLink(lark ? 'lark' : 'feishu', chatId) } })
  }
}
/**
 * 把已移除的 `github-issue` 来源的触发改派给 `github`，对有待发消息的每个 Issue，在其
 * `POLL_HORIZON_MS` 内的最早等待消息处安排一次重试，并删除废弃的 `github-issue` KV 键。
 */
function issueSourceRecords(store: Store): void {
  store.db.exec(`UPDATE trigger SET value = json_set(value, '$.source', 'github') WHERE value ->> '$.source' = 'github-issue'`)
  const pending = store.get('github-issue-pending' as Key<Record<string, { number: number; at: string }>>) ?? {}
  const retries = { ...store.get(KV.github.retries) }
  for (const { number, at } of Object.values(pending)) {
    if (!(Date.now() - Date.parse(at) < POLL_HORIZON_MS)) continue
    const retry = retries[number]
    retries[number] = { ...retry, since: retry && retry.since < at ? retry.since : at, pr: retry?.pr ?? false }
  }
  if (Object.keys(retries).length) store.set(KV.github.retries, retries)
  const kept = ['github-issue-pending', 'github-issues-since', 'github-issues-started-at', ...store.keys('github-issue-eligibility:')]
  for (const name of kept) store.delete(name)
}
/** 把每个 Issue/PR 的通知与线程订阅游标合并为持有较晚时间戳的单一游标。 */
function githubCursors(store: Store): void {
  for (const name of [...store.keys('github-thread:'), ...store.keys('thread-since:github:')]) {
    const at = store.get<string>(name as Key<string>)
    const cursor = KV.github.cursor(Number(name.slice(name.lastIndexOf(':') + 1)))
    const current = store.get(cursor)
    if (at && !(current && current >= at)) store.set(cursor, at)
    store.delete(name)
  }
}
/** 给待处理的评估 effect 附上触发 ID，并重新入队未送达的活跃评估，使其超时期限开始计时。 */
function assessmentTriggers(store: Store): void {
  const triggers = new Map(store.threads.active()
    .flatMap(thread => thread.evaluating ? [[thread.evaluating.id, thread.evaluating.triggerIds[0]] as const] : []))
  for (const row of store.db.prepare("SELECT key FROM effect WHERE kind = 'assessment' AND value ->> '$.triggerId' IS NULL").all()) {
    const triggerId = triggers.get(String(row.key))
    const named = JSON.stringify({ triggerId })
    if (triggerId) store.db.prepare("UPDATE effect SET value = ? WHERE kind = 'assessment' AND key = ?").run(named, row.key!)
    else store.db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(row.key!)
  }
  // 重新入队早于送达跟踪的活跃评估，使送达启动其超时期限，而不是让线程卡住。
  let seq = Number(store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  for (const thread of store.threads.active()) {
    const evaluation = thread.evaluating
    if (!evaluation || evaluation.delivered || !evaluation.triggerIds[0]) continue
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('assessment', ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING`)
      .run(evaluation.id, JSON.stringify({ triggerId: evaluation.triggerIds[0] }), ++seq, Date.now(), new Date().toISOString())
  }
}

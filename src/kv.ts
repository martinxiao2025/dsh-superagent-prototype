/**
 * 带类型的键值存储键与键族，按拥有并写入各键族的唯一组件分组。
 * 读写方通过这里的条目引用记录，使每个键只写一次并带上它的值类型。
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** 值为类型 `V` 的 KV 记录的键；普通字符串表示无类型的键。 */
export type Key<V> = string & { readonly __value?: V }
/** 共享同一前缀的 KV 记录族：可调用，由名称各部分构造键，并暴露 `prefix` 供列举使用。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** 定义一个带类型的 KV 键；外部 Source 插件用 `record` 和 `family` 为自己的键定型。 */
export const record = <V>(key: string) => key as Key<V>
/** 定义一个 KV 键族，其键用 `:`（或自定义 `format`）连接 `prefix` 与名称各部分。 */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store：当前数据库 schema 版本。 */
  store: { schema: record<number>('schema') },
  /** Settings：当前修订号、按块划分的修订号，以及已保存的设置快照（含当前快照）。 */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts：当前修订号与已保存的提示词版本。 */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** 某个被覆盖修改过的提示词部分的原始内置文本，按它的 `base` 索引，用于显示升级带来了哪些变化。 */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime：主 Session 的 ID。 */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions：每个 Session 工作过的提示词修订号，从旧到新排列；最后一项（`.at(-1)`）是它当前生效的修订；以及主会话已投递过的 request id（去重，保留最近若干条）。 */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:'),
    delivered: family<string[], [session: string]>('session-delivered:') },
  /** Schema 11 迁移：导入到 effect 表中的旧版主 Session 队列。 */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** 按 Source 解析的显示名，把具名 ID（如飞书会话 ID）映射到它的显示名。 */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source：通知游标与待处理的重试；通知读取与轮询读取共用的按 Issue/PR 读取游标；
   * 按流的游标、按种类的开始时间与 ETag；默认分支的 CI 状态；以及按 PR 的 CI 指纹与修订号（`revision`
   * 统计已上报的 CI 变化次数，使每次变化都产生不同的 Trigger ID）。
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source：已知会话（直接消息为 `true`）；按会话的历史游标，以及从话题 ID 映射到最近可见时间戳的活跃话题；
   * 以及按轮询线程的已见消息 ID 与初始化标志。
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}

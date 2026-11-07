/**
 * 带类型的键值存储键与键族，按各自唯一的所有者组件（负责写入该族）分组。
 * 读写方通过此处的条目引用一条记录，从而让每个键连同其值类型只拼写一次。
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** KV 记录的键，其值类型为 `V`；普通字符串表示未标注类型的键。 */
export type Key<V> = string & { readonly __value?: V }
/** 共享前缀的 KV 记录族：可像函数一样用名称各部分构造键，并暴露 `prefix` 供枚举使用。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** 定义单个带类型的 KV 键；外部 Source 插件用 `record` 和 `family` 为自己的键标注类型。 */
export const record = <V>(key: string) => key as Key<V>
/** 定义一个 KV 键族，其键由 `prefix` 和名称各部分用 `:` 连接而成（或使用自定义 `format`）。 */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store：当前数据库 schema 版本。 */
  store: { schema: record<number>('schema') },
  /** Settings：当前修订号、分块修订号，以及已保存的设置快照（含当前版本）。 */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts：当前修订号与已保存的 prompt 版本。 */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** 某 override 所基于的 prompt part 的内置文本，按其 `base` 索引，用于展示一次升级改动了什么。 */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime：主 Session 的 ID。 */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions：各 Session 工作时所用过的 prompt 修订号，按从旧到新排序；最后一项（`.at(-1)`）是其当前生效的修订号。 */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 迁移：导入效果表的旧版主 Session 队列。 */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** 每个 Source 解析后的显示名称，把带名字的 ID（如飞书群 ID）映射到其显示名。 */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source：通知游标与待重试项；通知读取与轮询读取共享的按 Issue/PR 读取游标；
   * 按 stream 的游标、按 kind 的起始时间以及 ETag；默认分支的 CI 状态；以及按 PR 的 CI 指纹与修订号（`revision`
   * 统计上报的 CI 变化次数，使每次变化都产生不同的 Trigger ID）。
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * 飞书 Source：已知的群聊（单聊取值为 `true`）；按群聊的历史游标，以及从话题 ID
   * 映射到最后可见时间戳的活动话题；还有按轮询线程的已见消息 ID 与初始化标志。
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}

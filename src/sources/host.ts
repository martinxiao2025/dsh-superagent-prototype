/** 把 Source 插件连接到应用的主机与上下文接口；Web 面板也会导入它，因此不得导入仅 Node 可用的模块。 */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/** 固定的英文健康文案模板（`{name}` 占位符）；面板会按界面语言本地化每个 `code`。 */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}
export interface SourceHost {
  readonly sources: SourceRegistry
  /** 返回某个 Source kind 的上下文；其 `report` 只能写入该 kind 声明的健康条目。 */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** Source 在 Thread 上发布的显示标签、URL 与事实（`null` 表示移除某个事实）。 */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** 暴露给 Source kind 的应用能力：读取状态、摄入 trigger、管理 thread 与工单，以及报告健康状态。 */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** 当 setup 解析出仓库与账号后为 true；Source 只在那之后才轮询。 */
  configured(): boolean
  /** 使该 Source 的账号无法运行的 setup 问题；只有飞书机器人检查会上报。 */
  readonly problem?: SetupProblem | undefined
  /** 返回 Source 启用时的配置；在禁用或未安装时返回 undefined。 */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** 把 trigger 摄入 Engine 并安排下一轮评估；调用方应等待完成后再推进读取游标。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** Source 作用域的 KV 记录（例如读取游标）；设为 `undefined` 会删除条目。 */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** 重新读取 Thread 后设置或删除（传 `undefined`）其 `meta` 中的键；Thread 不存在时不做任何事。 */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** 未结工单，最新的在前。 */
    open(): Ticket[]
    /** 把一个未结工单绑定为跟随某个 Source Thread（由该工单开启时为 `own`），使 Thread 关闭（而非 ready 报告）结束该工单。 */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** 报告被跟随的 Thread 于 `at` 关闭；当不再有 `own` Thread 处于开启且没有恢复的工作仍在运行时，跟随它的每个未结工单都会结束。 */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** Thread 上最新的 Trigger。 */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** 报告该 kind 已声明健康条目之一的状态；对未声明的条目名抛出错误。 */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)

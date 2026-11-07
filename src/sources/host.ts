/** 将 Source 插件接入应用的宿主与上下文接口；web 管理面板也会导入本文件，因此它不得导入仅限 Node 的模块。 */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/** 固定的英文健康模板（`{name}` 占位符）；管理面板会用界面语言对每个 `code` 进行本地化。 */
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
  /** 返回某个 Source kind 的上下文；其 `report` 只写入该 kind 声明的健康条目。 */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** Source 在某个 Thread 上发布的展示标签、URL 和事实（`null` 表示移除一项事实）。 */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** 暴露给 Source kind 的应用能力：读取状态、摄入触发、管理线程/工单以及报告健康。 */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** setup 解析出仓库与账号之后为真；Source 只有在此之后才轮询。 */
  configured(): boolean
  /** 阻碍该 Source 账号运行的 setup 问题；只有飞书 bot 检查会报告此类问题。 */
  readonly problem?: SetupProblem | undefined
  /** 在 Source 启用时返回其配置；停用或未安装时返回 undefined。 */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** 将触发摄入引擎并安排下一轮评估；调用方应先等待其完成，再推进读取游标。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** 以 Source 为作用域的 KV 记录（例如读取游标）；设置为 `undefined` 即移除该条目。 */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** 重新读取 Thread 后设置或移除（`undefined`）其 `meta` 中的键；Thread 不存在时不做任何处理。 */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** 打开中的工单，最新的在前。 */
    open(): Ticket[]
    /** 将打开中的工单绑定为跟随某个 Source Thread（`own` 表示该 Thread 由工单创建），使 Thread 的关闭（而非 ready 报告）终结该工单。 */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** 报告被跟随的 Thread 在 `at` 时刻关闭；每个跟随它的打开中工单，会在没有 `own` Thread 保持打开且没有恢复的工作仍在运行时终结。 */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** 某个 Thread 上最新的触发。 */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** 报告该 kind 声明的某个健康条目的状态；对未声明的条目名抛出异常。 */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)

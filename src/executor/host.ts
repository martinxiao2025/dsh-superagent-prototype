/** 宿主与 agent 执行的抽象：启动、健康检查、派发回合、结果回收与停止。 */
/**
 * 一个回合内可用的一次性 MCP 服务器。worker 的工具面经它暴露给回合里的 agent，
 * 因此宿主不需要理解工具语义。
 */
export interface McpServerConfig {
  /** 服务器名，agent 侧看到的前缀。 */
  readonly name: string
  /** 回环 HTTP 端点，仅本机可访问。 */
  readonly url: string
}
/** 交给宿主执行的一个回合。会话标识相同的连续回合共享同一段对话。 */
export interface TurnRequest {
  /** 会话标识；同一工单的连续回合复用它。 */
  readonly sessionId: string
  /** 回合的工作目录，通常是工单的 worktree。 */
  readonly directory: string
  /** 本回合的完整提示词，宿主原样交给 agent。 */
  readonly prompt: string
  /** 可选的模型名；缺省时由宿主决定。 */
  readonly model?: string
  /** 本回合额外暴露的 MCP 服务器。 */
  readonly mcp?: readonly McpServerConfig[]
}
/** 派发一座回合后得到的回执，供 `collect` 取回结果。 */
export interface TurnHandle {
  readonly sessionId: string
  /** 派发时刻，ISO 8601。 */
  readonly startedAt: string
}
/** 宿主的四种状态：尚未启动、可用、出错、已停止。 */
export type HostState = 'idle' | 'ready' | 'error' | 'stopped'
/** 宿主健康，供健康条目与面板读取；`detail` 是给人看的一句话。 */
export interface HostHealth {
  readonly state: HostState
  readonly detail: string
  /** 观测时刻，ISO 8601。 */
  readonly at: string
}
/** 一个回合的结局。`error` 存在时 `text` 可能为空，调用方不得把它当成成功。 */
export interface TurnResult {
  readonly sessionId: string
  readonly text: string
  /** 进程退出码；无法启动时为 -1。 */
  readonly exitCode: number
  readonly startedAt: string
  readonly endedAt: string
  /** 失败原因；成功回合没有这个字段。 */
  readonly error?: string
  /** 本回合实际使用的模型 id，宿主未报告时缺省。 */
  readonly model?: string
  /** 模型侧的 token 用量；`estimated` 为真时是本地计量而非服务端回报。 */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly estimated?: boolean }
}
/** `collect` 的选项。中止信号会终止该回合的进程。 */
export interface CollectOptions {
  readonly signal?: AbortSignal
}
/**
 * 宿主与 agent 执行之间唯一的接口。Runtime 只依赖它，不感知底层是 Copilot CLI、
 * 还是测试替身；换宿主不会改变领域规则或工具面。
 */
export interface AgentHost {
  /** 启动宿主并做一次可诊断的自检；失败时不抛出，而是把原因写进 `health()`。 */
  start(): Promise<void>
  /** 最近一次观测到的健康状态。 */
  health(): HostHealth
  /** 派发一个回合；不等待它结束。宿主已停止时抛出。 */
  dispatch(request: TurnRequest): Promise<TurnHandle>
  /** 等待并回收回合结果；同一个回执只能回收一次。 */
  collect(handle: TurnHandle, options?: CollectOptions): Promise<TurnResult>
  /** 终止所有在途回合并停止宿主。 */
  stop(): Promise<void>
}

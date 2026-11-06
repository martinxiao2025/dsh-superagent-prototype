/** 测试用的宿主替身：不启动任何进程，按预设脚本回答回合。 */
import type { AgentHost, HostHealth, TurnHandle, TurnRequest, TurnResult } from '../../src/executor/host.ts'
/**
 * 内存中的 `AgentHost`。它记录每个回合的请求，并按顺序返回预设结果；
 * 用于验证只依赖宿主接口的代码，不需要真实 CLI 或 DSH 会话。
 * 计划在改造第 ② 单元取代 `tests/fixtures/host.ts`。
 */
export class FakeAgentHost implements AgentHost {
  /** 收到的全部派发请求，按顺序。 */
  readonly requests: TurnRequest[] = []
  /** 收到但尚未回收的回执。 */
  readonly pending: TurnHandle[] = []
  private started = false
  private collected = 0
  private readonly answers: TurnResult[]
  /** 按顺序取用的回答；不足时用最后一个，再不足则返回空回复。 */
  constructor(answers: readonly Partial<TurnResult>[] = [{}]) {
    this.answers = answers.map(answer => ({ sessionId: answer.sessionId ?? '', text: answer.text ?? '完成。',
      exitCode: answer.exitCode ?? 0, startedAt: answer.startedAt ?? new Date().toISOString(),
      endedAt: answer.endedAt ?? new Date().toISOString(), ...(answer.error ? { error: answer.error } : {}) }))
  }
  /** 标记为已启动。 */
  async start(): Promise<void> { this.started = true }
  /** 启动后可用；否则仍是 idle。 */
  health(): HostHealth {
    return { state: this.started ? 'ready' : 'idle', detail: this.started ? '假宿主已就绪' : '尚未启动', at: new Date().toISOString() }
  }
  /** 记录请求并返回一个回执；不等待任何结果。 */
  async dispatch(request: TurnRequest): Promise<TurnHandle> {
    this.requests.push(request)
    const handle: TurnHandle = { sessionId: request.sessionId, startedAt: new Date().toISOString() }
    this.pending.push(handle)
    return handle
  }
  /** 返回下一个预设结果；没有派发过则抛出，避免调用顺序错乱被静默忽略。 */
  async collect(handle: TurnHandle): Promise<TurnResult> {
    const index = this.pending.findIndex(item => item === handle)
    if (index < 0) throw new Error(`未知的回合：${handle.sessionId}`)
    this.pending.splice(index, 1)
    const answer = this.answers[Math.min(this.collected, this.answers.length - 1)]
    this.collected += 1
    return { sessionId: handle.sessionId, text: answer?.text ?? '', exitCode: answer?.exitCode ?? 0,
      startedAt: handle.startedAt, endedAt: new Date().toISOString(), ...(answer?.error ? { error: answer.error } : {}) }
  }
  /** 清空在途回执并标记为已停止。 */
  async stop(): Promise<void> {
    this.started = false
    this.pending.length = 0
  }
}

/** 跨 Session 重启向 DSH agent 幂等投递消息。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** `requestId` 下所投递消息的 id，每次重试都相同。 */
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
/** 从当前或旧的插件消息来源中提取幂等键。 */
function deliveryId(message: UserMessage): string | undefined {
  // 已持久化的 source 可能早于当前按生产者划分的 source 映射。
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // 旧版用户 RPC 准入的请求保留其原始归属。
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * 在活跃与已恢复的 Session 中，按 request ID 向 DSH agent 至多投递一次消息。
 * 从实时 Session 事件、已持久化历史与待处理收件箱追踪已投递消息 ID，使 `Sessions` 的重试不会重复投递，
 * 并把已投递消息标记为 `dsh-superagent` 自身的来源（`dsh-superagent`）而非用户 RPC，以免被误认为人写的消息。
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** 向选定的收件箱投递一次，或注入历史而不唤醒 agent，并在向生产者确认之前刷新 Session 持久化。 */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const source = typeof mode === 'object' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'dsh-superagent' as const, form: 'relay' as const }
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
}

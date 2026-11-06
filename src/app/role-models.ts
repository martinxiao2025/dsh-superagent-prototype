/** 在新建 Session 上解析并预置各角色的默认模型，且不改动 DSH 的全局默认。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** 通过当前活跃的 provider 解析配置的路由；是否属于模型目录并不构成限制。 */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** 在全新 Session 首次请求之前预置该角色配置的模型，且不影响之后手动或持久化的模型选择。 */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  // 不使用 selectModel，因为它会改动 DSH 的全局默认；这里只为首次请求注入模型选择。
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}

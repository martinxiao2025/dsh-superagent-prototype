/** Executor Session 的工具：读取工单上下文、确认请求、管理 thread、交回超出范围的 trigger，以及上报状态。 */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source 上下文，其拉取请求规则用于约束对已上报 PR 的认领。 */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('读取 resource 参数所列的、属于本工单的资源的一页。请跟随 next_offset，页面给出 next_resource 时也跟随它。',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: '按 replies 一节所述，在实质性工作之前确认一条原始的人为请求；它作为对该消息的回复发出。',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`最多 ${IM_WORDS} 个词；支持 Markdown。`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: '按 work 一节所述，停止跟随一个不关于本工单的已附加 Thread；它自己的 Thread 不能被去掉。',
      schema: z.object({
        thread: z.string().min(1).describe('Thread 键；它某条消息的 trigger/<id> 会以 thread 显示该键，例如 feishu:<chat>:<root> 或 github:<number>。'),
        reason: z.string().trim().min(1).max(300).describe('一句话说明该 Thread 为何不关于本工单。'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: '仅作为上下文跟随一个相关的 Thread，例如某个 Issue 或另一个 PR。',
      schema: z.object({
        thread: z.string().describe('Thread 键，例如 github:<number>。'),
        reason: z.string().trim().min(1).max(300).describe('用一句话说明它如何相关。'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('Thread 键的形式是 <source>:<id>，例如 github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: '把要求本工单之外或另一张工单的工作的消息交回，以做一次新的评估；每条消息只交回一次。另一张工单仍在决定它时，queued 为 false；对于从来不该由本工单决定的消息，例如机器人的消息，queued 也为 false，那种消息会在没有这次交回的情况下照常被评估。',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('一句话说明它要求了本工单之外的什么。'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: '按 work 与 handoff 两节所述，汇报 progress、ready、blocked、failed 或 dropped。',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('向人提出的一个具体问题，state=progress 时也可用；省略则保留待处理的问题，null 则清除它。'),
        question_for_trigger_id: z.string().optional().describe('配合 human_action：提出该问题的人的消息；问题会在那个人写下它的地方提出。'),
        pr_number: z.number().int().positive().nullish().describe(`该工单的 PR：它的 Source PR，或由 ${host.github.deployment.github.login} 从以本工单命名的分支（DSH_SUPERAGENT_NAME）创建的 PR。`),
        reply_to_trigger_id: z.string().optional().describe('本次汇报所回答的显式的人的问题；普通进度绝不要用它。'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('工单已结束（PR 已关闭或工作已完成）；不要恢复它')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // 原子地认领 PR、记录报告并入队中继，这样 PR 认领被拒或报告无效都不会留下部分状态，而已记录的报告一定能送达主 Session。
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}

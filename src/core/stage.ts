/** 工单阶段分类与重试资格（docs/003）。 */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/** 工单的高层执行阶段：等待人、正在工作或排队、两轮对话间空闲，或已结束。 */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** 判定工单的阶段；规则按 docs/003 中表格的顺序执行，先匹配到的行生效。 */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // blocked 或 failed 报告之后的人的跟进会把工单交还给执行器。
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** 当未结工单因 blocked/failed 报告停滞且没有更新的人的跟进，或存在失败的输入投递时为 true。 */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

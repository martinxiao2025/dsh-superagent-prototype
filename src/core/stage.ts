/** ticket 阶段分类与重试资格（docs/003）。 */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/** ticket 的高层执行阶段：等待人工、正在工作或排队中、轮次之间空闲，或已结束。 */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** 对 ticket 的阶段分类；规则按 docs/003 中的表格顺序执行，首个匹配的行生效。 */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // blocked 或 failed 报告之后的人的后续消息会把 ticket 交回 executor。
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** 当开放 ticket 因 blocked/failed 报告停滞且没有更新的人的后续消息，或存在失败的 input 投递时为 true。 */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

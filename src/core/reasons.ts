/**
 * 用于决策、被过滤的 trigger 与已结束 assignment 的结构化原因码与模板。
 * Policy 闸门与 source scope 也可能发出各自字面量的原因码。
 */
export const REASONS = {
  said: '{text}',
  timeout: '评估超时',
  policyChanged: '评估期间 Policy 已变更',
  noAdmissible: '没有可准入的 Trigger',
  startedTicket: '已在工单 {ticket} 中开始',
  acceptedBefore: 'Trigger {trigger} 此前已被接受',
  routed: '已路由到工单 {ticket}',
  explicitRouted: '允许的发送者发出明确请求，由编排器路由',
  humanStop: '人要求停止',
  legacyImport: '从领域模型之前的任务记录导入',
  forwarded: '已转发给该 Thread 上工单的 worker',
  senderNotMember: '发送者不在该 Source 的名单中',
  retried: '由人重试',
  hostRestarted: 'dsh-superagent 已重启',
  stopUnknown: '停止目标未知或已结束',
  stopNotExplicit: '停止需要名单内发送者的明确请求',
  directionUnsettled: '实现意图或目标方向尚未确立，或仍需产品/设计决策',
  noRuleMatched: '没有匹配到已启用的准入规则',
  ignoredFromCard: '从卡片上忽略，未做规则评估',
  observed: '观察模式：本会接受（{text}）',
} as const
export type ReasonCode = keyof typeof REASONS
/** 原因码与模板取值；`triggerId` 标识该原因在同批中适用于哪个 trigger。 */
export interface Reason { code: ReasonCode | (string & {}); values?: Record<string, string>; triggerId?: string }
export const said = (text: string): Reason => ({ code: 'said', values: { text } })
/** 将原因格式化为可读文本（存在 `triggerId` 时加上前缀）供 agent 使用。 */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []].flat().map(reason => {
    const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
    const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match)
    return reason.triggerId ? `${reason.triggerId}: ${text}` : text
  }).join('; ')
}

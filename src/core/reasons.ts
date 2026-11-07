/**
 * 决定、被过滤的触发与已结束的派工所用的结构化理由 code 与模板。
 * 策略准入和 Source 范围也可以发出各自的字面理由 code。
 */
export const REASONS = {
  said: '{text}',
  timeout: 'Assessment timed out',
  policyChanged: 'Policy changed during assessment',
  noAdmissible: 'No admissible trigger',
  startedTicket: 'Already started ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to ticket {ticket}',
  explicitRouted: 'Explicit request from an allowed sender routed by the orchestrator',
  humanStop: 'Human asked to stop',
  legacyImport: 'Imported from the pre-domain-model task record',
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread',
  senderNotMember: 'The sender is not on the Source\'s list',
  retried: 'Retried by a person',
  hostRestarted: 'dsh-superagent-cn restarted',
  stopUnknown: 'Stop target is unknown or already ended',
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list',
  directionUnsettled: 'Implementation intent or target direction is not established, or a product/design decision is still required',
  noRuleMatched: 'No enabled admission rule matched',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
} as const
export type ReasonCode = keyof typeof REASONS
/** 理由 code 与模板取值；`triggerId` 标识批次中该理由所针对的触发。 */
export interface Reason { code: ReasonCode | (string & {}); values?: Record<string, string>; triggerId?: string }
export const said = (text: string): Reason => ({ code: 'said', values: { text } })
/** 以英文格式化理由（存在时以 `triggerId` 为前缀）供 agent 使用。 */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []].flat().map(reason => {
    const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
    const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match)
    return reason.triggerId ? `${reason.triggerId}: ${text}` : text
  }).join('; ')
}

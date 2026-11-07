import { describe, expect, it } from 'vitest'
import { canRetry, ticketStage, type Assignment, type ReportState, type Ticket } from '../src/core/index.ts'

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'a', state: 'running', createdAt: '', ...overrides })
const reported = (state: ReportState, overrides: Partial<Assignment> = {}) => assignment({ report: { state, summary: '', at: '' }, ...overrides })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
  channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides })
const attention = { id: 'q', question: '?' }
/** 在报告之后才到达工单的用户消息。 */
const answered = { inputs: [{ id: 'i', kind: 'trigger' as const, triggerId: 'e', at: 'later', human: true as const }] }
const reportedAt = (state: ReportState) => reported(state, { report: { state, summary: '', at: 'earlier' } })
const ended = { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }

// docs/003 表格的各行，按顺序；命中多行的工单取第一行。
describe('ticketStage', () => {
  it.each([
    ['一条未送达的输入', ticket({ delivery: { error: 'offline', at: '' } }), { stage: 'person', action: 'delivery' }],
    ['送达先于回答与复核', ticket({ delivery: { error: 'offline', at: '' }, attention, assignments: [reported('ready')] }), { stage: 'person', action: 'delivery' }],
    ['一个待人工决定', ticket({ attention }), { stage: 'person', action: 'answer' }],
    ['回答先于复核', ticket({ attention, assignments: [reported('ready')] }), { stage: 'person', action: 'answer' }],
    ['回答先于失败', ticket({ attention, assignments: [reported('failed')] }), { stage: 'person', action: 'answer' }],
    ['一份 ready 报告', ticket({ assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    ['一份已结束派工的 ready 报告', ticket({ assignments: [reported('ready', { state: 'ended' })] }), { stage: 'person', action: 'review' }],
    ['一份 blocked 报告', ticket({ assignments: [reported('blocked')] }), { stage: 'person', action: 'blocked' }],
    ['一份 failed 报告', ticket({ assignments: [reported('failed')] }), { stage: 'person', action: 'failed' }],
    ['一份用户已回答的 blocked 报告', ticket({ ...answered, assignments: [reportedAt('blocked')] }), { stage: 'working' }],
    ['没有派工', ticket({ assignments: [] }), { stage: 'working', action: 'queued' }],
    ['一份 pending 派工', ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }), { stage: 'working', action: 'queued' }],
    ['一份 waiting 报告', ticket({ assignments: [reported('waiting')] }), { stage: 'idle' }],
    ['一份已结束的派工', ticket({ assignments: [assignment({ state: 'ended' })] }), { stage: 'idle' }],
    ['一份运行中的派工', ticket(), { stage: 'working' }],
    ['一份 progress 报告', ticket({ assignments: [reported('progress')] }), { stage: 'working' }],
    ['一个已结束的工单', ticket({ ended, attention, assignments: [reported('failed')] }), { stage: 'ended' }],
  ])('%s', (_name, value, stage) => { expect(ticketStage(value)).toEqual(stage) })
})

describe('canRetry', () => {
  it.each([
    ['失败的进行中工单', true, ticket({ assignments: [reported('failed')] })],
    ['阻塞的进行中工单', true, ticket({ assignments: [reported('blocked')] })],
    ['还在等回答的失败工单', true, ticket({ attention, assignments: [reported('failed')] })],
    ['输入未送达的阻塞工单', true, ticket({ delivery: { error: 'offline', at: '' }, assignments: [reported('blocked')] })],
    ['已结束的失败工单', false, ticket({ ended, assignments: [reported('failed')] })],
    ['已重试过、新派工尚在 pending 的工单', false, ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] })],
    ['ready 的工单', false, ticket({ assignments: [reported('ready')] })],
    ['运行中的工单', false, ticket()],
    ['没有派工的工单', false, ticket({ assignments: [] })],
    // 执行器 Session 已拿到用户消息，工单阶段也如实反映，重试只会打断它。
    ['用户已回答过的失败工单', false, ticket({ ...answered, assignments: [reportedAt('failed')] })],
    // 除非那条消息投递失败：新派工会让执行器 Session 重新启动并取走消息。
    ['用户回答投递失败的失败工单', true,
      ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })],
    ['输入未能送达的进行中工单', true, ticket({ delivery: { error: 'offline', at: '' } })],
    ['输入未能送达的已结束工单', false, ticket({ ended, delivery: { error: 'offline', at: '' } })],
  ])('%s: %s', (_name, expected, value) => { expect(canRetry(value)).toBe(expected) })
  it('在每种可由新派工补救的 person 阶段都提供重试', () => {
    const delivery = ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })
    expect(ticketStage(delivery)).toEqual({ stage: 'person', action: 'delivery' })
    expect(canRetry(delivery)).toBe(true)
  })
})

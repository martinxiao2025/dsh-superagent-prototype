import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage,
  waitsForPerson } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from '../src/core/index.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void
  prepareTicket?: EngineOptions['prepareTicket']
}
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const withdrawn: string[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  /** 执行器交给运行中派工的输入，形如 [工单 id, 输入 id]。 */
  const delivered: [string, string][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn(),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  }
  let clock = 0
  const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } }
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: id => { withdrawn.push(id) },
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  /** 模拟执行器启动排队的派工（除非 `launch` 为 false）并投递待处理的工单输入。 */
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) { delivered.push([ticketId, inputId]); engine.inputsDelivered(ticketId, assignment.id, [inputId]) }
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  /** 模拟 worker 的 Session 把已投递但尚未读入步骤的触发输入收进来。 */
  const read = (ticketId: string) => engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input =>
    input.kind === 'trigger' && input.readAt === null ? [input.id] : []))
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, outbox, withdrawn, requests, assessor, executor, delivered, settle, pump, read, decide,
    setVersion: (value: string) => { version = value }, setPaused: (value: boolean) => { paused = value }, tick: (seconds: number) => { clock += seconds } }
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); h.pump()
  const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  h.settle()
  return decision
}

describe('接入', () => {
  it('一个触发只存储一次，并记录 source 的过滤', () => {
    const h = harness()
    expect(h.engine.receive(trigger('1'))).toBe('stored')
    expect(h.engine.receive(trigger('1'))).toBe('duplicate')
    expect(h.engine.receive(trigger('2', { meta: { blocked: true } }))).toBe('filtered')
    expect(h.repo.triggers.disposition('2')?.filtered).toEqual({ code: 'chat not allowed' })
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['1'])
  })
  it('为多线程上的触发记录关联，且只在主线程上评估', () => {
    const h = harness()
    h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }))
    expect(h.repo.threads.get('gh:pr-7')).toMatchObject({ pending: ['1'], correlated: ['gh:run-9'] })
    expect(h.repo.threads.get('gh:run-9')).toMatchObject({ pending: [], correlated: ['gh:pr-7'] })
  })
})
describe('评估', () => {
  it('没有可准入的内容时在准入处忽略，不经评估器', async () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false })); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore', triggerIds: ['1'] })])
    expect(h.repo.triggers.disposition('1')?.decisionId).toBeDefined()
  })
  it('为每个结束的评估释放评估器状态，无论是否做出决定', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    expect(h.assessor.release).toHaveBeenCalledExactlyOnceWith(h.requests[0]!.evalId)
  })
  it('按线程串行评估，并合并期间到达的触发', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.pump()
    expect(h.requests).toHaveLength(1)
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['2', '3'])
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    h.pump()
    expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(['2', '3'])
    expect(h.requests[1]!.strength).toBe('explicit')
  })
  it('接受会创建带授权的工单、订阅线程、排队确认并发起一次派工', async () => {
    const h = harness()
    const decision = accepted(h)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ title: 'Fix', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: member, scope: 'small' }, channels: [trigger('1').channel],
      origin: { triggerId: '1', triggerIds: ['1'] } })
    expect(ticket).not.toHaveProperty('ended')
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
    expect(h.repo.threads.get('chat:t1')?.subscriptions).toEqual([ticket.id])
    expect(h.outbox).toEqual([{ id: key('ack', '1'), channel: trigger('1').channel, text: 'ok', kind: 'acknowledgement', ticketId: ticket.id }])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('拒绝决定已被后续评估取代的评估，并决定后续那个', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const first = h.requests[0]!
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2'); h.pump()
    const second = h.requests[1]!
    expect(() => h.decide(first, { kind: 'ignore', reason: 'chatter' })).toThrow('has finished or a later eval replaced it')
    expect(h.decide(second, { kind: 'ignore', reason: 'chatter' })).toMatchObject({ kind: 'ignore', evalId: second.evalId })
  })
  it('接受连同其工单、订阅与确认一起记录，否则什么都不记录', async () => {
    const h = harness({}, { prepareTicket: () => { throw new Error('No directory for the ticket') } })
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    expect(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })).toThrow('No directory')
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ evaluating: { id: evalId }, subscriptions: [] })
    expect(h.outbox).toEqual([])
  })
  it('研判期间策略版本变化时记录 unavailable', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.setVersion('v2')
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })
    expect(decision.kind).toBe('unavailable')
    expect(h.repo.tickets.list()).toEqual([])
  })
  it('一步启动所有待评估，第二次 pump 不会重复启动', () => {
    const h = harness()
    for (const [id, thread] of [['1', 'A'], ['2', 'B']] as const) h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
    expect(h.engine.evaluateDue()).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(['chat:A', 'chat:B'])
  })
  it('评估的期限从其投递算起，到期后把触发重新排队两次，然后记录 unavailable', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    // 评估器 Session 尚未取走的候选不会到期。
    h.tick(600); h.pump()
    expect(h.engine.candidate('1')?.evalId).toBe(h.requests[0]!.evalId)
    const deliver = () => { h.engine.candidateDelivered(h.requests.at(-1)!.evalId) }
    deliver()
    h.tick(59); h.pump()
    expect(h.requests).toHaveLength(1)
    // 到期后它什么也不记录，把触发重新排队等待新的评估，共两次。
    h.tick(2); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId)
    expect(h.requests.map(item => item.triggers.map(each => each.id))).toEqual([['1'], ['1']])
    deliver(); h.tick(61); h.pump()
    expect(h.requests).toHaveLength(3)
    // 第三次到期记录为 unavailable。
    deliver(); h.tick(61); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'timeout' }] })])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('订阅扇出', () => {
  it('把已订阅线程上人的后续消息作为上下文送达存活的工单，而不送评估', async () => {
    const h = harness()
    const decision = accepted(h)
    const requests = h.requests.length
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: '2' })])
    expect(ticket.undelivered).toEqual([])
    expect(h.delivered).toEqual([[ticket.id, ticket.inputs[0]!.id]])
    expect(h.repo.triggers.disposition('2')).toEqual({ fanout: [ticket.id], at: expect.any(String) })
    // 没有评估，因此没有决定与超时，线程的队列为新请求保持空闲。
    expect([h.requests.length, h.repo.threads.get('chat:t1')!.pending, h.repo.decisions.byThread('chat:t1').length]).toEqual([requests, [],
      1])
    h.tick(600); h.engine.evaluateDue()
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    // 那里的 bot 消息仍送评估，准入不会放行它。
    h.engine.receive(trigger('3', { human: false })); h.pump()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['3'] })
  })
  it('输入在派工运行前保持未投递，并再次要求启动启动失败的派工', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    h.settle({ launch: false })
    h.engine.receive(trigger('2')); h.engine.evaluateDue(); h.settle({ launch: false })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.undelivered).toHaveLength(1)
    expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id); h.settle()
    expect(h.delivered).toEqual([[ticket.id, ticket.undelivered[0]!]])
  })
  it('不把 bot 消息交给已结束的工单，但仍对它评估', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { human: false })); h.pump()
    // 执行器恢复时会重新读取其线程，因此 bot 与 CI 既不唤醒也不在已结束工单上排队。
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('无论 pump 多少次只恢复一次，恢复说明先于消息，策略不再支持授权时丢弃等待的内容', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    h.setVersion('v1')
    h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.ended).toBeDefined()
    h.engine.receive(trigger('3', { actor: guest })); h.pump(); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.inputs.filter(input => input.kind === 'resumed')).toHaveLength(1)
  })
  it('只接受仍在运行未结束工单的派工的投递报告', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.receive(trigger('2'))
    const input = key('input', ticketId, 'trigger', '2')
    h.engine.deliveryFailed(ticketId, assignment, 'Session busy')
    expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    h.engine.deliveryFailed(ticketId, 'another', 'other')
    h.engine.inputsDelivered(ticketId, 'another', [input])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [input], delivery: { error: 'Session busy' } })
    h.engine.inputsDelivered(ticketId, assignment, [input])
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([])
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    h.engine.receive(trigger('3')); h.engine.stopTicket(ticketId)
    h.engine.deliveryFailed(ticketId, assignment, 'late')
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
  it('取消订阅线程会停止扇出，直到新的决定再次订阅它', async () => {
    const h = harness()
    const decision = accepted(h)
    expect(h.engine.unsubscribe('chat:t1')).toBe(true)
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([])
  })
  it('允许执行器放弃挂到其工单的线程，保留该线程上的其他工单，但不包括它自己的线程', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = []
    const h = harness({}, { emit: event => events.push(event) })
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    // 第二个工单的跟进只有在第二个工单的 worker 交回后才会到第一个。
    h.engine.handback(second, '3', 'It is about the first fix')
    h.engine.attach(first, '3')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second, first])
    h.engine.markUnrelated(first, 'chat:t2', 'about another fix')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second])
    expect(events.filter(event => event.type === 'thread.unsubscribed').map(event => event.data))
      .toEqual([{ threadKey: 'chat:t2', ticketId: first, by: 'executor', reason: 'about another fix' }])
    expect(() => h.engine.markUnrelated(first, 'chat:t2', 'again')).toThrow(new UserError('notFollowing'))
    expect(() => h.engine.markUnrelated(first, 'chat:t1', 'its own')).toThrow(new UserError('sourceThread'))
    h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true)
    expect(() => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR')).toThrow(new UserError('followedThread'))
  })
})
describe('恢复与停止', () => {
  async function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human') {
    const decision = accepted(h)
    if (by === 'executor') h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    else h.engine.stopTicket(decision.ticketId!)
    return decision.ticketId!
  }
  it('线程上任何人的消息都会恢复已结束的工单，用同样的授权，且不产生决定', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    const decisions = h.repo.decisions.byThread('chat:t1').length
    // 消息一到它就恢复，不经过对消息的任何评估。
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    h.pump()
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.mandate.policyVersion).toBe('v1')
    expect(ticket.inputs.map(input => input.kind)).toEqual(['trigger', 'resumed'])
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    // 消息仍作为跟进到达评估，但不需要也不可能有重新打开的决定。
    expect(h.repo.decisions.byThread('chat:t1').filter(decision => decision.kind !== 'ignore')).toHaveLength(decisions)
  })
  it('在下一轮恢复早期版本留下有人消息等待的已结束工单', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const stored = h.repo.tickets.get(ticketId)!
    const input = { id: 'waiting', kind: 'trigger' as const, triggerId: '2', at: stored.updatedAt, human: true as const }
    h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ['waiting'] })
    h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ kind: 'resumed' })]) })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
  })
  it('人把消息挂载到已结束工单时立即恢复它', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const subject = h.engine.attach(ticketId, '2')
    expect(subject).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'pending' })] })
    expect(subject).not.toHaveProperty('ended')
  })
  it('被人停止的工单保持结束：停止撤回了它的授权', async () => {
    const h = harness()
    const ticketId = await ended(h, 'human')
    expect(h.executor.stop).toHaveBeenCalledOnce()
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('授权不再通过当前策略时工单保持结束', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.setVersion('revoked')
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
  })
  it('只在明确的指示下停止存活的工单，并以人工结束它', async () => {
    const h = harness()
    const decision = accepted(h)
    // 到达工单的跟进：主 Session 处理其中一条时由准入判定，访客的判为 inferred。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' })).toMatchObject({ kind: 'ignore',
      strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] })
    h.engine.receive(trigger('3')); h.pump()
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind).toBe('stop')
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.stop).toHaveBeenCalledOnce()
  })
})
describe('跟进', () => {
  it('把早期版本排队的跟进无决定地移出队列，再次送评估的则保留', () => {
    const h = harness()
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.receive(trigger('3', { actor: guest }))
    // 如早期版本留下的样子：两者都排队等评估；第二条被人再次送去评估。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, pending: ['2', '3'] })
    h.engine.reevaluate('3'); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1').flatMap(decision => decision.triggerIds)).toEqual(['1'])
  })
  it('在其线程进行中的评估之外，用仅准入的评估决定跟进，原评估继续进行', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const evaluating = h.repo.threads.get('chat:t1')!.evaluating!
    h.engine.receive(trigger('3'))
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'stop it' })).toMatchObject({ kind: 'stop',
      triggerIds: ['3'] })
    expect(h.repo.threads.get('chat:t1')!.evaluating).toEqual(evaluating)
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })).toMatchObject({ kind: 'ignore', triggerIds: ['2'] })
  })
  it('为到达不了工单的后续请求保持线程空闲', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    h.engine.stopTicket(decision.ticketId!, 'not needed')
    // 工单决定该跟进期间它没有占用评估，因此下一个请求立即评估而不是等超时，
    // 与那条在 worker 接手前被停止放开的跟进一起。
    h.engine.receive(trigger('3')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
})
describe('交回', () => {
  it('把到达工单的消息按准入的强度重新排队等新评估，每个工单一次，并保留订阅',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.engine.handback(ticketId, '2', 'A new request')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'explicit', triggers: [{ id: '2' }] })
    expect(h.repo.triggers.disposition('2')!.handbacks).toEqual([{ ticketId, reason: 'A new request', at: expect.any(String) }])
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })
    expect(() => h.engine.handback(ticketId, '2', 'Again')).toThrow(new UserError('handedBack'))
    expect(h.engine.handback(ticketId, '3', 'A guest asks for more')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred', triggers: [{ id: '3' }] })
    expect(h.repo.threads.get('chat:t1')!.subscriptions).toContain(ticketId)
    // 只有到达过工单的消息才能交回。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.handback(ticketId, '4', 'Not mine')).toThrow(new UserError('notReached'))
  })
  it('不重新排队工单未决定的消息：人送评估的、bot 的，或为上下文关注的线程上的',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.receive(trigger('2')); h.engine.reevaluate('2')
    h.engine.receive(trigger('3', { human: false })); h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] })); h.pump()
    for (const candidate of h.requests.slice(-2)) h.decide(candidate, { kind: 'ignore', reason: 'chat' })
    // 每条都在工单之外送去评估，其决定仍然有效。
    for (const id of ['2', '3', '4']) expect(h.engine.handback(ticketId, id, 'Not this ticket')).toBe(false)
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.threads.get('chat:issue')!.pending]).toEqual([[], []])
    // 交回照样被记录，主 Session 因此不会把消息重新挂回。
    expect(h.repo.triggers.disposition('4')!.handbacks).toEqual([{ ticketId, reason: 'Not this ticket', at: expect.any(String) }])
    expect(() => h.engine.attach(ticketId, '4')).toThrow(new UserError('handedBackHere'))
  })
  it('主 Session 挂载到工单的消息交给其 worker，其交回会把消息送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    // 已路由给工单的消息也不能同时是新工作。
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Y', scope: 'small', reason: 'requested' }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.handback(ticketId, '2', 'Asks for another change')).toBe(true)
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
})
describe('上下文线程与备注', () => {
  it('把为上下文关注的线程扇出给存活的工单，不据此恢复已结束工单，除非消息曾被挂载', async () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(true)
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(false)
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === 'trigger' && input.triggerId)).toEqual(['2'])
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // 被主 Session 挂载后，线程成为工单自己的线程，那里人的后续消息会恢复它。
    h.engine.attach(ticketId, '3'); h.settle()
    expect(h.repo.threads.get('chat:issue')).toMatchObject({ context: [] })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('工单仅为上下文关注的线程上的消息不算其跟进，也不用它解除受阻', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [owner, follower], context: [follower] })
    expect(h.repo.tickets.get(follower)!.inputs.at(-1)).toMatchObject({ triggerId: '3', context: true })
    // 不再算关注者自己的线程：只到达它的消息送去评估，连同已被停止的所有者放开的访客消息。
    h.engine.stopTicket(owner, 'done')
    h.engine.report(follower, { state: 'blocked', summary: 'needs a decision' })
    h.engine.receive(trigger('4')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3', '4'])
    expect(waitsForPerson(h.repo.tickets.get(follower)!)).toBe(true)
  })
  it('到达的工单无法恢复、只剩一个为其上下文关注线程的工单时，把消息送去评估', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.report(owner, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('3')); h.setVersion('v1'); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [follower], context: [follower] })
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
  })
  it('给未结束工单的 worker 一条作为独立输入的备注，像自动输入一样持留，已结束工单则拒绝', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.note(ticketId, 'The other ticket renamed the API').inputs.at(-1)).toMatchObject({ kind: 'note',
      text: 'The other ticket renamed the API' })
    // 报告 blocked 的 worker 在等人：备注不会唤醒它。
    h.settle()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    const note = h.engine.note(ticketId, 'Ticket B changed the schema').inputs.at(-1)!
    h.settle()
    expect(h.delivered.map(([, id]) => id)).not.toContain(note.id)
    expect(h.repo.tickets.get(ticketId)!.inputs).toContainEqual(note)
    h.engine.stopTicket(ticketId, 'done')
    expect(() => h.engine.note(ticketId, 'Too late')).toThrow(new UserError('ticketEnded'))
  })
})
describe('跟进的归属', () => {
  const accept = { kind: 'accept' as const, title: 'Y', scope: 'small', reason: 'requested' }
  const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') })
  it('主 Session 据此停止工单后可把跟进作为新工作接手', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // “停掉这个，改做 Y”：停止结束了决定该消息的工单，因此该请求归主 Session。
    h.engine.receive(trigger('2')); h.settle()
    expect(() => h.engine.decide('2', accept)).toThrow(decides(ticketId))
    expect(h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' }).kind).toBe('stop')
    // 同一时刻，接受成为停止之外一个自己的决定。
    expect(h.engine.decide('2', accept)).toMatchObject({ kind: 'accept', triggerIds: ['2'] })
    expect(h.repo.decisions.byThread('chat:t1').filter(item => item.triggerIds.includes('2')).map(item => item.kind)).toEqual(['stop',
      'accept'])
  })
  it('工单因报告或停止结束时，把 worker 从未收到的跟进送去评估', () => {
    for (const end of ['report', 'stop'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2'))
      expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
      if (end === 'report') h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      else h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
      h.pump()
      expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2'])
    }
  })
  it('工单结束时，把 worker 自上次报告后收到的跟进送去评估，除非它已确认', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    // worker 确认了两条消息中的一条，其最终报告在它接手另一条之前已在路上。
    h.tick(1); h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
    // 工单不再算作到达过它，因此其候选不指名那条未给出理由的工单。
    expect([h.repo.triggers.disposition('2')!.fanout, h.repo.triggers.disposition('3')!.fanout]).toEqual([[ticketId], []])
  })
  it('PR 合并后，worker 正在处理其上次报告后接手的人的消息时，工单保持打开',
    () => {
    for (const taken of [true, false]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
      h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
      // 人再要求一处改动，worker 接手或尚未接手，其间 PR 合并。
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      if (taken) h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
      h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
      // 未接手的那条让合并来结束工单，并送去评估。
      expect([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get('chat:t1')!.pending]).toEqual(taken ? [undefined, []]
        : ['merged', ['2']])
      // worker 的 ready 报告按 PR 的结果结束它。
      if (taken) h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
      expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    }
  })
  it('主 Session 把已结束工单放开的跟进挂回该工单时，把跟进再次交给它', () => {
    for (const resumed of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      // 工单在其 worker 接手人的消息之前结束，消息送去评估；后续消息可恢复它。
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (resumed) { h.tick(1); h.engine.receive(trigger('3')) }
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      // 其 worker 再次拿到消息，已结束的工单为它恢复。
      const copies = h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')
      expect(h.delivered).toContainEqual([ticketId, copies[1]?.id])
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(trigger('2'), h.repo)).toEqual([ticketId])
    }
  })
  it('挂载到已结束工单的消息若 worker 只作为上下文读过或在最后报告前读过，会唤醒工单', () => {
    for (const read of ['context', 'report'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      if (read === 'context') h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
      h.tick(1); h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: read === 'context' ? 'issue' : 't1' }] })); h.settle()
      // worker 读过后报告并放弃工单；人从管理面板把它曾有的跟进送去评估。
      h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'read it' })
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (read === 'report') h.engine.reevaluate('2')
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(h.repo.triggers.get('2')!, h.repo)).toEqual([ticketId])
    }
  })
  it('最终报告回答的问题算作已接手，因此不会作为候选随其答案一起回来', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'It reads the config.', answers: '2' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId], acked: [ticketId] })
  })
  it('评估为 unavailable 后被挂载的消息，在其工单未接手而结束时送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
  it('早期版本排队但未记录到消息上的确认也算作接手了消息', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.outbox.push({ id: key('ack', '2'), channel: trigger('2').channel!, text: 'On it', kind: 'acknowledgement', ticketId })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.triggers.disposition('2')!.fanout]).toEqual([[], [ticketId]])
  })
  it('恢复工单的消息算作由再次结束工单的报告接手，与后来才到的不同', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    // 人的致谢恢复了工单，其 worker 先把它收进步骤，在派工启动片刻之后，随执行器的投递；
    // 一条请求在它报告无事可做时到来。
    h.tick(1); h.engine.receive(trigger('2'))
    h.tick(1); h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id)
    h.tick(1); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('对它的停止被拒绝后把工单放开的跟进送去评估，停止所据以结束的那条则不送', () => {
    // 访客的停止被拒绝，worker 放弃工单；成员的停止结束工单，停止它的主 Session 自行决定消息的其余部分。
    for (const actor of [guest, member]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2', { actor }))
      h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' })
      if (actor === guest) h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(actor === guest ? ['2'] : [])
    }
  })
  it('停止据以结束某工单的消息，在其到达的另一个工单未接手而结束后送去评估', () => {
    const h = harness()
    const stopped = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(other, { source: 'chat', id: 't1' }, false)
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.decide('2', { kind: 'stop', ticketId: stopped, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    h.engine.report(other, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('把 worker 认为无关的线程上的跟进交回评估，并附上其理由', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    h.engine.receive(trigger('3', elsewhere)); h.settle()
    expect(() => h.engine.decide('3', accept)).toThrow(decides(ticketId))
    // worker 发现被挂载的线程不属于其工单，且不在那里回复：主 Session 挂载的消息与后面那条一起交回，
    // 每个候选都说明原因。
    h.engine.markUnrelated(ticketId, 'chat:x', 'about something else')
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2', '3'])
    expect(h.repo.triggers.disposition('3')!.handbacks).toEqual([{ ticketId, reason: 'about something else', at: expect.any(String) }])
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
  it('两条工单都到达的跟进取未交回的那条，两者都不决定时把它排队', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.handback(first, '2', 'another change'); h.pump()
    const second = h.decide(h.requests.at(-1)!, accept).ticketId!
    h.settle()
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    expect(h.repo.triggers.disposition('3')!.fanout).toEqual([first, second])
    expect(h.engine.handback(first, '3', 'for the other ticket')).toBe(false)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    // 第二个工单的 worker 决定它期间，主 Session 既不能接手也不能忽略。
    expect(() => h.engine.decide('3', accept)).toThrow(decides(second))
    expect(() => h.engine.decide('3', { kind: 'ignore', reason: 'chat' })).toThrow(decides(second))
    expect(h.engine.handback(second, '3', 'neither ticket')).toBe(true)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('让早期版本为跟进启动的评估决定它', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.settle()
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit',
      actor: member, basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } })
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' })).toMatchObject({ kind: 'ignore',
      triggerIds: ['2'] })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('被打断的派工', () => {
  it('带一条说明重新启动工作中被打断的派工，并把等待的内容交给等待中的派工', () => {
    const h = harness()
    const interrupted = accepted(h).ticketId!
    const first = h.repo.tickets.get(interrupted)!.assignments[0]!
    const waiting = accepted(h, '2', 't2').ticketId!
    h.engine.report(waiting, { state: 'waiting', summary: 'done for now' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    vi.mocked(h.executor.start).mockClear(); vi.mocked(h.executor.deliver).mockClear()
    // 执行器报告每个曾在运行的派工；关于已不再运行的派工的事实会被丢弃。
    for (const id of [interrupted, waiting]) h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id)
    h.engine.assignmentInterrupted(interrupted, first.id)
    const ticket = h.repo.tickets.get(interrupted)!
    expect(ticket.assignments).toEqual([expect.objectContaining({ id: first.id, state: 'ended', endedReason: 'hostRestarted' }),
      expect.objectContaining({ state: 'pending' })])
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('The host restarted') })])
    expect(ticket.undelivered).toEqual([ticket.inputs[0]!.id])
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: interrupted }), ticket.assignments[1])
    // 等待中的 worker 保留其 Session，并拿到等待它的内容。
    expect(h.repo.tickets.get(waiting)!.assignments).toHaveLength(1)
    expect(h.executor.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: waiting }), expect.objectContaining({ state: 'running' }))
  })
  it('再次启动已报告但随后收到人的消息并正在处理的 worker', () => {
    const h = harness()
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.report(other, { state: 'waiting', summary: 'done for now' })
    h.tick(1); h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] })); h.settle()
    const running = runningAssignment(h.repo.tickets.get(other)!)!
    expect(running.deliveredAt! > running.report!.at).toBe(true)
    h.engine.assignmentInterrupted(other, running.id)
    expect(h.repo.tickets.get(other)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  })
})
describe('暂停', () => {
  it('处理暂停期间不让任何评估到期，并把其期限顺延暂停的时长', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.candidateDelivered(h.requests[0]!.evalId)
    const deadline = Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)
    h.tick(30); h.setPaused(true); h.pump()
    // 暂停越过期限，评估保持等待。
    h.tick(300); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    h.setPaused(false); h.pump()
    expect(Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)).toBe(deadline + 300_000)
    h.tick(29); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    // 到期后把触发重新排队等待新的评估。
    h.tick(1); h.pump()
    expect(h.engine.candidate('1')?.evalId).not.toBe(h.requests[0]!.evalId)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('策略变更', () => {
  it('只把变更如何作用于其工单告知受影响的存活工单，并以新版本重启进行中的评估', async () => {
    const h = harness()
    const decision = accepted(h)
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const effect = { rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }] }
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]))
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })])
    expect(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === 'policy-changed')).toEqual([])
    expect(h.repo.decisions.byThread('chat:t2')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })])
    expect(h.repo.threads.get('chat:t2')?.pending).toEqual(['2'])
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '2' })] })
    const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === 'policy-changed')!
    expect(h.delivered).toEqual([[decision.ticketId, told.id]])
  })
  it('暂停期间不启动评估', async () => {
    const h = harness({ paused: true })
    h.engine.receive(trigger('1')); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })
})

describe('worker 报告', () => {
  it('询问、保留、替换并清除给人的问题，并说明报告替换了哪个问题', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: 'Which color?', askedBy: '1' })
    expect(asked.attention).toMatchObject({ question: 'Which color?', triggerId: '1' })
    expect(h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' }).attention).toEqual(asked.attention)
    expect(h.withdrawn).toEqual([])
    const replaced = h.engine.report(ticketId, { state: 'progress', summary: 'other question', question: 'Which size?' })
    expect(replaced.attention).toMatchObject({ question: 'Which size?' })
    expect(replaced.attention).not.toHaveProperty('triggerId')
    // 被替换的问题若其消息尚未发出，会从发件箱撤回。
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id)])
    const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null })
    expect(cleared).not.toHaveProperty('attention')
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id), key('attention-reply', replaced.attention!.id)])
  })
  it('最终报告结束工单：dropped 放弃它，ready 完成它，除非它仍关注某个 source 的未关闭线程', () => {
    const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' })
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
      // 两个线程都关闭后恢复的工作以其 ready 报告结束，采用最近一次关闭的结果。
      if (closed) {
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z')
        h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z')
      }
      h.engine.report(ticketId, { state, summary: 'done' })
      return h.repo.tickets.get(ticketId)!
    }
    expect(outcome('dropped', true)).toMatchObject({ ended: { by: 'executor', outcome: 'dropped' } })
    expect(outcome('dropped', true).ended).not.toHaveProperty('reason')
    expect(outcome('ready', false)).toMatchObject({ ended: { outcome: 'completed' } })
    expect(outcome('ready', false)).not.toHaveProperty('attention')
    expect(outcome('ready', true)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }, { thread: 'gh:pr-10', own: true }],
      assignments: [expect.objectContaining({ report: expect.objectContaining({ state: 'ready' }) })] })
    expect(outcome('ready', true)).not.toHaveProperty('ended')
    expect(outcome('ready', true)).not.toHaveProperty('attention')
    expect(outcome('ready', true, true)).toMatchObject({ ended: { outcome: 'merged' } })
    expect(outcome('failed', false)).toMatchObject({ attention: { question: 'Merge it?' } })
    expect(outcome('failed', false)).not.toHaveProperty('ended')
  })
  it('拒绝带结果或答案的问题，以及未指名工单上人的消息的问题或答案', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { human: false, threads: [{ source: 'chat', id: 't1' }] }))
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const report = (extra: object) => () => h.engine.report(ticketId, { state: 'progress', summary: 'x', ...extra })
    expect(report({ state: 'ready', question: 'Q?' })).toThrow(new UserError('questionWithResult'))
    expect(report({ question: 'Q?', answers: '1' })).toThrow(new UserError('questionWithResult'))
    expect(report({ askedBy: '1' })).toThrow(new UserError('askerWithoutQuestion'))
    expect(report({ question: 'Q?', askedBy: '2' })).toThrow(new UserError('notAsker'))
    expect(report({ answers: '4' })).toThrow(new UserError('notAnswerable'))
    expect(report({ answers: '1' })()).toMatchObject({ answers: ['1'] })
  })
  it('拒绝已结束工单的报告', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' })).toThrow(new UserError('ticketEnded'))
  })
})
describe('结果', () => {
  it('记录工单如何结束', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId, 'Human asked to stop')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'Human asked to stop' })
    expect(ticketOutcome(h.repo.tickets.get(ticketId)!)).toBe('stopped')
    expect(ticketOutcome({})).toBeUndefined()
  })
})
describe('挂载', () => {
  it('为 worker 已有的消息发送路由说明，结束只含该消息的评估，拒绝被人停止或策略不再支持的工单', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '2')])
    // 该跟进未经理由评估到达工单，由其 worker 判断；被人再次送评估后由那里判断。
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.reevaluate('2')).toBe(true); h.pump()
    expect(h.engine.candidate('2')).toBeDefined()
    const attached = h.engine.attach(ticketId, '2', 'The guest asks for the same fix'); h.settle()
    expect(attached.inputs).toEqual([expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '2', note: 'The guest asks for the same fix' })])
    expect(h.delivered.map(([, input]) => input)).toEqual(attached.inputs.map(input => input.id))
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticketId } }] })
    // 仍在等待 worker 的消息，其说明随之一并发送，如同被人直接送评估的消息那样。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5')
    expect(h.engine.attach(ticketId, '5', 'Same fix again').inputs.at(-1)).toMatchObject({ triggerId: '5', note: 'Same fix again' })
    h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('mandateRevoked'))
    h.setVersion('v1')
    const stopped = accepted(h, '3', 't3').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.attach(stopped, '2')).toThrow(new UserError('ticketStopped'))
    expect(() => h.engine.attach('missing', '2')).toThrow(new UserError('unknownTicket'))
  })
  it('结束被挂载消息所在的批次评估并重新评估其余，把该消息留给那个工单', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.engine.receive(trigger('3', elsewhere)); h.pump()
    h.engine.attach(ticketId, '3'); h.pump()
    expect(h.repo.decisions.byThread('chat:x')).toEqual([expect.objectContaining({ kind: 'unavailable', triggerIds: ['2', '3'],
      reason: [{ code: 'routed', triggerId: '3', values: { ticket: ticketId } }] })])
    expect(h.engine.candidate('2')?.triggers.map(item => item.id)).toEqual(['2'])
    expect(followupOwners(h.repo.triggers.get('3')!, h.repo)).toEqual([ticketId])
    expect(() => h.engine.attach(other, '3')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
  })
  it('把缺失的情况与拒绝区分开，并填入取值', () => {
    expect([new UserError('unknownTicket').missing, new UserError('ticketEnded').missing]).toEqual([true, false])
    expect(new UserError('notAdmissible', { reason: 'not_a_member' })).toMatchObject({ code: 'notAdmissible', values: { reason: 'not_a_member' }, message: 'Trigger is not admissible: not_a_member' })
  })
})
describe('直接决定', () => {
  it('在直接评估中决定没有评估持有的显式请求，拒绝没有匹配规则的主动接受，且一个触发只接受一次', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    const decision = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' })
    expect(decision).toMatchObject({ kind: 'accept', triggerIds: ['1'], strength: 'explicit' })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' })).toEqual(decision)
    // 访客的跟进未经理由评估到达该工单：由其 worker 决定，只有 worker 交回的内容才能成为新工作，
    // 且以准入的授权、即 inferred。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticketId = decision.ticketId!
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['r1'] }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    h.engine.handback(ticketId, '2', 'A different fix')
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'proactive' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule',
      rules: ['r1'] })).toMatchObject({ kind: 'accept', strength: 'inferred' })
    expect(() => h.engine.decide('missing', { kind: 'ignore', reason: 'x' })).toThrow(new UserError('unknownTrigger'))
  })
  it('只按策略允许的规则接受 inferred 候选，无论由谁指名', () => {
    const h = harness({ admitsInferred: rules => rules.includes('enabled') })
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const candidate = h.requests.at(-1)!
    expect(() => h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['disabled'] })).toThrow(new UserError('notExplicit'))
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['enabled'] })).toMatchObject({ kind: 'accept' })
  })
  it('结束已开启工单的重放触发所在的评估，并返回该工单为其准备的决定', () => {
    const h = harness()
    const decision = accepted(h)
    h.tick(1)
    expect(h.engine.reevaluate('1')).toBe(true)
    h.pump()
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['1'],
      reason: [{ code: 'startedTicket', triggerId: '1', values: { ticket: decision.ticketId } }] })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(() => h.engine.reevaluate('missing')).toThrow(new UserError('unknownTrigger'))
  })
  it('把已开启工单的重放触发排除在与它一起排队的触发所在的评估之外', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    // 成员的重放请求不会把授权借给访客的消息。
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.engine.candidate('2')).toMatchObject({ strength: 'inferred', triggers: [{ id: '2' }] })
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
  it('从与重放请求一同被接受的请求开启工单，带其自己的来源与确认', () => {
    const h = harness()
    const first = accepted(h)
    h.tick(1); h.engine.receive(trigger('2')); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    const second = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed', acknowledgement: 'On it' })
    expect(second.ticketId).not.toBe(first.ticketId)
    expect(h.repo.tickets.get(second.ticketId!)!.origin).toEqual({ triggerId: '2', triggerIds: ['2'] })
    expect(h.outbox.find(message => message.id === key('ack', '2'))).toMatchObject({ text: 'On it', kind: 'acknowledgement' })
    // 重放的请求仍以其开启的工单作答。
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' })).toEqual(first)
  })

})
describe('自动输入', () => {
  it('报告 blocked 或 failed 的 worker 的自动输入被扣住，直到人的消息到达', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const bot = (id: string) => trigger(id, { human: false })
    h.engine.receive(bot('2'))
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    // 待处理的与随后到来的自动输入都留在工单队列上，不唤醒 worker。
    h.engine.receive(bot('3')); h.settle()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], inputs: [expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '3' })] })
    expect(h.delivered).toEqual([])
    h.tick(1)
    h.engine.receive(trigger('4', { actor: guest })); h.engine.receive(bot('5')); h.settle()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '4'), key('input', ticketId, 'trigger', '5')])
  })
  it('人的消息、随后既非 blocked 也非 failed 的报告、或一次重试都会解除等人状态', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    expect(waitsForPerson(ticket())).toBe(true)
    expect(ticketStage(ticket())).toEqual({ stage: 'person', action: 'blocked' })
    // worker 已拿到人的回复，过期的 blocked 报告不再扣住工单。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest })); h.settle()
    expect(waitsForPerson(ticket())).toBe(false)
    expect(ticketStage(ticket())).toEqual({ stage: 'working' })
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    expect(waitsForPerson(ticket())).toBe(true)
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'found a way' })
    expect(waitsForPerson(ticket())).toBe(false)
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId)
    expect(waitsForPerson(ticket())).toBe(false)
  })
  it('人的消息会再次启动启动失败的派工，策略变更则不会', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const ticketId = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' }).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'The prepare command failed' })
    vi.mocked(h.executor.start).mockClear()
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2')
    expect(h.executor.start).not.toHaveBeenCalled()
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticketId }), expect.objectContaining({ state: 'pending' }))
  })
})
describe('回复', () => {
  it('对到达未结束工单的人的消息只确认一次，其余拒绝', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // 接受时的确认保留；之后再请求确认会复用它。
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '1', text: 'On it' })).toEqual({ id: key('ack', '1'), status: 'pending', reused: true })
    expect(h.outbox.map(message => message.text)).toEqual(['ok'])
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'Looking' })).toEqual({ id: key('ack', '2'), status: 'pending', reused: false })
    h.engine.receive(trigger('3', { human: false }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '3', text: 'x' })).toThrow(new UserError('ackNotPerson'))
    h.engine.receive(trigger('6', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '6', text: 'x' })).toThrow(new UserError('notReached'))
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'x' })).toThrow(new UserError('ackEnded'))
  })
  it('答案只在 worker 报告后发送，结果只发给 ready 的工单，提醒只针对其当前问题', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } })
    h.engine.receive(asked)
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toThrow(new UserError('noAnswer'))
    h.engine.report(ticketId, { state: 'progress', summary: 'Yes', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toMatchObject({ status: 'pending', reused: false })
    expect(h.outbox.at(-1)).toMatchObject({ channel: asked.channel, text: 'Yes', kind: 'reply' })
    expect(h.repo.tickets.get(ticketId)!.answers).toEqual([])
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Which color?', askedBy: '2' })
    expect(() => h.engine.reply({ purpose: 'attention', ticketId, question: 'Which size?', text: 'x' })).toThrow(new UserError('notAttention'))
    // 没有未决问题时无事可问，无论是否指名了问题。
    const quiet = accepted(h, '9', 't9').ticketId!
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, question: '', text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    const attention = h.repo.tickets.get(ticketId)!.attention!
    expect(h.engine.reply({ purpose: 'attention', ticketId, question: 'Which color?', text: 'Which color?' }).id).toBe(key('attention-reply', attention.id))
    // 问题去到提出它的消息所写之处。
    expect(h.outbox.at(-1)!.channel).toEqual(asked.channel)
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ status: 'pending' })
    expect(h.outbox.at(-1)!.channel).toEqual(trigger('1').channel)
  })
})
describe('工单命令', () => {
  it('线程关闭与 ready 报告按同一规则结束工单：它开启的 PR 都不再打开时结束，以最近一次结束为准', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // 它从别人的 PR 出发，并开启了自己的 PR。
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-5' }, false)
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-7' }, 'merged', '2026-09-23T00:00:00Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 人的评论恢复它；其 ready 报告再次按自己 PR 的结果结束它，尽管出发点 PR 仍打开。
    h.tick(10); h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-5' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    h.engine.report(ticketId, { state: 'ready', summary: 'Answered' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 出发点 PR 后来关闭不改变任何东西。
    h.engine.threadClosed({ source: 'gh', id: 'pr-5' }, 'closed', '2026-09-23T00:00:30Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 未开启 PR 的工单在其关注的线程关闭时按其结果结束。
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-8' }, false)
    h.engine.report(other, { state: 'ready', summary: 'Pushed to their branch' })
    expect(h.repo.tickets.get(other)).not.toHaveProperty('ended')
    h.engine.threadClosed({ source: 'gh', id: 'pr-8' }, 'closed', '2026-09-23T00:01:00Z')
    expect(h.repo.tickets.get(other)!.ended).toMatchObject({ outcome: 'closed' })
  })
  it('人移除订阅时不再关注该线程', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    expect(h.engine.unsubscribe('gh:pr-7')).toBe(true)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('follows')
    // 其 ready 报告完成它，因为它如今不再关注任何线程。
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
  })
  it('关注 source 的线程，自己的线程都不再打开时结束，除非恢复的工作尚未完成', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const close = (id: string, outcome: 'merged' | 'closed', at: string) => {
      const open = h.repo.tickets.open().map(ticket => ticket.id)
      h.engine.threadClosed({ source: 'gh', id }, outcome, at)
      return open.filter(item => h.repo.tickets.get(item)!.ended)
    }
    expect(h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }] })
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
    expect(h.repo.threads.get('gh:pr-9')!.subscriptions).toEqual([ticketId])
    // 它出发的线程在其自己的线程打开时关闭：它记录关闭并继续工作。
    expect(close('pr-9', 'closed', '2026-09-23T00:00:00Z')).toEqual([])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ follows: [{ thread: 'gh:pr-9', closed: { outcome: 'closed' } }, { thread: 'gh:pr-10' }] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    // 它自己的线程也关闭：它按那个线程的结果、在其关闭时刻结束，且只结束一次。
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([ticketId])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-23T00:00:01.000Z' } })
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([])
    expect(() => h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-11' }, true)).toThrow(new UserError('ticketEnded'))
    // 在 PR 关闭之后、关闭被报告之前重试的工单继续工作，直到它报告 ready。
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-12' }, true)
    h.engine.report(other, { state: 'failed', summary: 'tests fail' })
    h.tick(10); h.engine.retryTicket(other)
    expect(close('pr-12', 'closed', '2026-09-23T00:00:05Z')).toEqual([])
    expect(h.repo.tickets.get(other)!.ended).toBeUndefined()
    h.engine.report(other, { state: 'ready', summary: 'done' })
    expect(h.repo.tickets.get(other)).toMatchObject({ ended: { outcome: 'closed' } })
  })

  it('用新派工重试报告 failed 的工单，且只向等待中的 worker 索取状态', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
    expect(h.engine.requestStatus(ticketId)).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([])
    h.engine.report(ticketId, { state: 'waiting', summary: 'idle' })
    expect(h.engine.requestStatus(ticketId)).toBe(true)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('status-only') })])
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments).toEqual([expect.objectContaining({ state: 'ended', endedReason: 'retried' }), expect.objectContaining({ state: 'pending' })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: ticketId }), retried.assignments[1])
  })
})
describe('失败的投递', () => {
  it('新派工接手或工单结束后忘记失败的投递', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const failed = () => {
      h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, 'Session busy')
      expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    }
    failed()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    failed()
    h.engine.stopTicket(ticketId)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
})
describe('问题', () => {
  it('只消除 unavailable 决定所显示的问题，且只限这类决定', () => {
    const h = harness()
    const decision = accepted(h)
    expect(() => h.engine.dismiss(decision.id)).toThrow(new UserError('unknownProblem'))
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const unavailable = h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    expect(h.engine.dismiss(unavailable.id)).toMatchObject({ kind: 'unavailable', dismissed: true })
    expect(h.repo.decisions.get(unavailable.id)).toMatchObject({ dismissed: true })
  })
})
describe('投递失败后的重试', () => {
  it('输入持续无法送达 worker 的工单会获得新派工，由它接下输入', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'tests fail' })
    // 人的答案发给已失败的 worker，投递它失败。
    h.tick(5); h.engine.receive(trigger('2'))
    const answered = h.repo.tickets.get(ticketId)!
    expect(answered.undelivered).toHaveLength(1)
    h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, 'Session gone')
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: 'person', action: 'delivery' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
    expect(retried).not.toHaveProperty('delivery')
    expect(retried.undelivered).toHaveLength(1)
  })
})
describe('跨策略版本的评估、被撤销的授权与混合批次', () => {
  it('评估按更旧的策略被决定时重新排队其批次，例如升级改变了版本之后', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const candidate = h.requests.at(-1)!
    // 升级改变版本而无需报告策略变更。
    h.setVersion('v2')
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r' })).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: ['1'] })
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '1' })] })
  })
  it('其到达的唯一工单在当前策略下无法恢复时把人的消息排队等评估，并表明它没有到达任何工单', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setVersion('revoked')
    h.tick(5); h.engine.receive(trigger('2'))
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
  })
  it('暂停解除后其到达的工单无法恢复时，把等待暂停结束的人的消息排队等评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setPaused(true)
    h.tick(5); h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
    h.setVersion('revoked'); h.setPaused(false); h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending.includes('2') || h.engine.candidate('2') !== undefined).toBe(true)
  })
  it('新工单的来源与确认取自赋予其批次强度的那个可准入触发', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci-bot' }, channel: { source: 'chat', thread: 'chat:t1', address: { message: 'bot' } } }))
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['1', '2'])
    const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r', acknowledgement: 'ok' })
    expect(h.repo.tickets.get(decision.ticketId!)!.origin).toEqual({ triggerId: '1', triggerIds: ['1', '2'] })
    expect(h.outbox).toEqual([expect.objectContaining({ id: key('ack', '1'), channel: trigger('1').channel })])
  })
})
describe('边界情况', () => {
  it('混合批次的强度、发起者与依据取自其最强的可准入触发，同强度时取最新的', () => {
    // 访客的消息按 inferred 准入，如同在工单关注的线程上。
    const gate: Policy['gate'] = t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    for (const order of [['guest', 'alice'], ['alice', 'guest']]) {
      const h = harness({ gate })
      order.forEach((who, index) => { h.tick(1); h.engine.receive(trigger(String(10 + index), { actor: who === 'alice' ? member : guest })) })
      h.pump()
      const alice = String(10 + order.indexOf('alice'))
      expect(h.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ strength: 'explicit', actor: member, basis: { via: 'listed' }, primary: alice })
    }
    const named = harness({ gate: t => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', sender: t.actor.id } }) })
    named.engine.receive(trigger('1', { actor: { source: 'chat', id: 'bob' } }))
    named.tick(1); named.engine.receive(trigger('2', { actor: { source: 'chat', id: 'carol' } }))
    named.pump()
    expect(named.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ actor: { id: 'carol' }, basis: { sender: 'carol' }, primary: '2' })
  })
  it('被重试取代的派工迟到的启动不改变任何东西，也不投递任何东西', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.retryTicket(ticketId)
    const before = h.repo.tickets.get(ticketId)!
    const delivered = h.delivered.length
    h.engine.assignmentStarted(ticketId, first); h.settle({ launch: false })
    expect(h.repo.tickets.get(ticketId)!.assignments).toEqual(before.assignments)
    expect(h.delivered).toHaveLength(delivered)
  })
  it('指名未知或已结束工单的停止记录为 ignored', () => {
    const h = harness()
    const ended = accepted(h).ticketId!
    h.engine.report(ended, { state: 'ready', summary: 'Done' })
    for (const [id, ticketId] of [['2', 'missing'], ['3', ended]] as const) {
      h.tick(1); h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: `t${id}` }] })); h.pump()
      expect(h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId, reason: 'stop it' })).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopUnknown' }] })
    }
    expect(h.repo.tickets.get(ended)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('拒绝准入不放行的触发的直接决定，队列保持原样', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    const pending = h.repo.threads.get('chat:t1')!.pending
    expect(() => h.engine.decide('1', { kind: 'ignore', reason: 'noise' })).toThrow(new UserError('notAdmissible', { reason: 'not human' }))
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(pending)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
  it('拒绝重试失败报告之后被人停止的工单', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
  })
  it('问题只回答一次，结果只发给已完成的工作，同一结果只发一次', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'progress', summary: 'It reads the config.', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'It reads the config.' })).toMatchObject({ reused: false })
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Something else.' })).toThrow(new UserError('noAnswer'))
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    const sent = h.outbox.length
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: false })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: true })
    expect(h.outbox).toHaveLength(sent + 1)
    // PR 关闭但未合并的工单、或被人停止的工单没有结果可发。
    const closed = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(closed, { source: 'gh', id: 'pr-1' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'closed', '2026-09-23T00:01:00Z')
    expect(() => h.engine.reply({ purpose: 'result', ticketId: closed, text: 'x' })).toThrow(new UserError('notReady'))
    const stopped = accepted(h, '6', 't6').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.reply({ purpose: 'result', ticketId: stopped, text: 'x' })).toThrow(new UserError('notReady'))
  })
  it('重复投递时评估期限不变，拒绝把已持有的触发再次排队，并把到期的触发排在最前', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    h.engine.candidateDelivered(evalId)
    const deadline = h.repo.threads.get('chat:t1')!.evaluating!.deadline
    h.tick(30); h.engine.candidateDelivered(evalId)
    expect(h.repo.threads.get('chat:t1')!.evaluating!.deadline).toBe(deadline)
    expect(h.engine.reevaluate('1')).toBe(false)
    // 期间到达的触发排在到期者之后，新的评估按此顺序一并处理。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    h.tick(30); h.engine.evaluateDue()
    expect(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds).toEqual(['1', '2'])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('最终审查', () => {
  it('忽略早期版本留下的只含已开启工单触发的评估，而不是记录 unavailable', () => {
    const h = harness()
    const decision = accepted(h)
    // 早期版本可能在触发开启工单后仍让评估持有它。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'old-eval', threadKey: 'chat:t1', triggerIds: ['1'], primary: '1', strength: 'explicit', actor: member,
      basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '', deadline: '2999-01-01T00:00:00.000Z' } })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'replayed' })).toEqual(decision)
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'startedTicket', triggerId: '1',
      values: { ticket: decision.ticketId } }] })
    expect(h.repo.decisions.byThread('chat:t1').some(item => item.kind === 'unavailable')).toBe(false)
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
  })
  it('准入忽略线程排队的内容时清掉到期评估的计数', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, expired: 1 })
    h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore' })])
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('最终审查：策略转变', () => {
  it('把每个与其工单相关的策略变更告知 worker，包括重复早先转变的那次', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const effect = { requesterAllowed: false as const }
    for (const [from, to] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) { h.tick(1); h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]])) }
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(3)
  })
})
describe('最终审查：为上下文关注的线程', () => {
  it('只为上下文关注的线程上，worker 既不能确认也不能向任何人提问', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'side' })
    h.tick(1); h.engine.receive(trigger('5', { threads: [{ source: 'chat', id: 'side' }], channel: { source: 'chat', thread: 'side', address: { message: '5' } } }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '5', text: 'On it' })).toThrow(new UserError('notReached'))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'A question', question: 'Which page?', askedBy: '5' })).toThrow(new UserError('notAsker'))
  })
})
describe('最终审查：关闭时间', () => {
  it('把 source 的关闭时间记录为规范形式，并保持工单的 updatedAt 前进', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-1' }, true)
    h.tick(30)
    const before = h.repo.tickets.get(ticketId)!.updatedAt
    // GitHub 给整秒，且 PR 在工单最后一次变更之前合并。
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:05Z')
    const ended = h.repo.tickets.get(ticketId)!
    expect(ended.ended).toMatchObject({ at: '2026-09-23T00:00:05.000Z', outcome: 'merged' })
    expect(ended.follows).toEqual([{ thread: 'gh:pr-1', own: true, closed: { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' } }])
    expect(ended.updatedAt >= before).toBe(true)
  })
})
describe('模型表面审查', () => {
  it('只有人的消息恢复已结束工单，挂载给它的 bot 消息不行', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci' }, threads: [{ source: 'chat', id: 'ci' }] }))
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // 人的消息连同等待的内容一起恢复它。
    h.tick(1); h.engine.receive(trigger('3'))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('跟进审查：turn 结束', () => {
  const merge = (h: ReturnType<typeof harness>) => h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
  it('合并只把 worker 在 ready 报告之后没有轮次读到的消息送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    // 人向 worker 致谢，worker 在一个轮次中读过并放下它；另一条消息在该轮次之后到来。
    h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    merge(h)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('合并时 worker 正在处理其接手的消息则工单保持打开，进度报告之后也是如此', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    // 它在处理该消息期间用进度报告回答了另一个问题。
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Answered the other question' })
    merge(h)
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('worker 之后放弃工作时，把其推迟过关闭的工单按关闭的结果结束', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    merge(h)
    h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing more to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('另一工单交回的消息，在对它的停止结束持有它的工单时送去评估', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    expect(h.engine.handback(second, '3', 'It is about the first fix')).toBe(false)
    h.engine.decide('3', { kind: 'stop', ticketId: first, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('把人送评估、主 Session 又挂回的 worker 曾有的消息再次交给存活工单的 worker', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.engine.reevaluate('2'); h.pump()
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')).toHaveLength(2)
  })
})
describe('跟进审查：turn 结束与投递', () => {
  it('某轮次结束时仍在等待投递、之后才到达 worker 的消息，在对它的停止下送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // 消息在路上时轮次结束；它随后到达 worker，人在该轮次中停止了工单。
    h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('跟进审查：投递时间', () => {
  it('在 worker 的等待报告之前到来、却在报告之后才到达 worker 的消息，在对它的停止下送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // 消息在路上时执行器报告 worker 等待；它随后到达 worker，人停止了工单。
    h.tick(1); h.engine.report(ticketId, { state: 'waiting', summary: 'Waiting for input' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('路由审查', () => {
  it('同一时刻对到达两个工单的同一跟进做出的两次停止记录为两个决定', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    const stops = [first, second].map(ticketId => h.engine.decide('3', { kind: 'stop', ticketId, reason: 'asked to stop' }))
    expect(new Set(stops.map(stop => stop.id)).size).toBe(2)
    expect(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId)).toEqual([first, second])
    expect([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
  })
})

describe('worker 读过的内容', () => {
  /** 一个已结束、被人消息 `2` 恢复且新派工已启动的工单；其输入等待投递。 */
  function resumed() {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.tick(1); h.engine.receive(trigger('2'))
    const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id
    h.tick(1); h.engine.assignmentStarted(ticketId, assignmentId)
    const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [string, string]
    return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get('chat:t1')!.pending }
  }
  it('唤醒工单却在进度报告之后才到达 worker 的消息，在 dropped 报告时送去评估', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // 消息的投递起初失败；worker 报告进度，重试在其写下无事可做时把消息交过去。
    h.engine.inputsDelivered(ticketId, assignmentId, [note])
    h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual(['2'])
  })
  it('唤醒工单的消息在其 worker 的 Session 收进步骤后，算作被稍后的 dropped 报告读过', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // Session 在执行器记录投递之前，把它收进其到达所启动的步骤。
    h.engine.inputsRead(ticketId, [message])
    h.engine.inputsDelivered(ticketId, assignmentId, [note, message])
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual([])
  })
  it('合并时把在其最后一步之后才到达 worker、且没有任何步骤在其轮次结束前收下它的消息送去评估', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('重试在失败与轮次结束之后投递的消息，只有步骤收下它才算被 dropped 报告读过', () => {
    for (const taken of [false, true]) {
      const { h, ticketId, assignmentId, note, message, pending } = resumed()
      h.engine.inputsDelivered(ticketId, assignmentId, [note])
      h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
      h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
      h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
      if (taken) h.read(ticketId)
      h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
      expect(pending()).toEqual(taken ? [] : ['2'])
    }
  })
  it('重启打断其轮次之前步骤已收下的消息，只有重启后的 worker 报告后才算读过', () => {
    for (const reported of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
      // 派工带一条恢复说明再次启动，仍在同一 Session 中，其中持有该消息。
      h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id); h.settle()
      if (reported) { h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Recovered' }) }
      h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(reported ? [] : ['2'])
    }
  })
})
describe('读取认领审查', () => {
  it('把已失败的派工投递过但 worker 没有任何步骤收下的消息交给重试的派工', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputId = ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === '2')!.id
    expect(ticket().undelivered).toEqual([])
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'The turn broke.' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputId])
  })
})
describe('读取认领审查：重试', () => {
  it('重试只拿到其所取代派工投递过且没有步骤收下的内容，而不是更早结束放开的', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    // 一条跟进到达 worker，工单在任何步骤收下它之前结束，这把它送去评估。
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    // 人的消息恢复工单；其 worker 在步骤收下消息之前报告 blocked，人进行重试。
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('3')])
  })
})
describe('读取认领审查：重启', () => {
  it('重启的派工拿到被取代者投递过且没有步骤收下的内容，再次重试又会拿到它', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    // host 在步骤收下消息之前工作中重启，取消可能已丢弃消息：新派工拿到它。
    h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id)
    expect(ticket().undelivered[0]).toBe(inputOf('2'))
    h.settle()
    // 该派工在步骤收下消息之前 blocked，人进行重试：重试的派工也会拿到它。
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('2')])
  })
})
describe('来自卡片的忽略', () => {
  const said = (text: string) => ({ code: 'said', values: { text } })
  it('标记未经评估判定的 inferred 候选的忽略，与经过评估的或显式候选的不同', () => {
    const h = harness()
    accepted(h)
    // 被送去评估的访客消息是 inferred 候选，主 Session 从其卡片忽略它。
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred' })
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'Plain chat.' }).reason).toEqual([{ code: 'ignoredFromCard' }, said('Plain chat.')])
    // 评估做出的忽略保留其规则判定，不带该标记。
    h.engine.receive(trigger('3', { actor: guest })); h.engine.reevaluate('3'); h.pump()
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Plain chat.', audit: { rule_assessments: [] } }))
      .toMatchObject({ reason: [said('Plain chat.')], audit: { rule_assessments: [] } })
    // 显式候选总是从其卡片路由。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't9' }] })); h.pump()
    expect(h.engine.decide('4', { kind: 'ignore', reason: 'Thanks.' }).reason).toEqual([said('Thanks.')])
    // 接受 inferred 候选仍需评估的匹配规则。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5'); h.pump()
    expect(() => h.engine.decide('5', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'chat' })).toThrow(new UserError('notExplicit'))
  })
})

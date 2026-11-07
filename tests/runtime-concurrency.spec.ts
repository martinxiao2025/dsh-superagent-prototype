/** 触发、投递与执行器 Session 启动重叠时的并发运行时行为。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { Later } from '../src/app/effects.ts'
import { reportRelay } from '../src/app/notices.ts'
import { WorkerSlots, inputMessage, mandateInstructions, ticketExecution, transient, triggerMessage } from '../src/executor/dsh.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
const linkLookedUp = (messageId: string) =>
  vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('+messages-mget') && args.includes(messageId))
/** 挂起某个 Session 的首次解析，直到 `gate` 解决；`held()` 返回是否已开始。 */
function holdSession(sessionId: string, gate: Promise<void>) {
  let held = false
  h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === sessionId && !held) { held = true; await gate } return h.resolveDefault(id) })
  return () => held
}
/** Session 的 agent 回合结束，DSH 随之发出通知。 */
const idle = (sessionId: string) => {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}

it('较早候选的卡片还在等待其链接时到达线程的消息，在该线程的下一次评估中被研判', async () => {
  const gate = deferred()
  // 第一个候选的来源链接查询很慢；飞书允许它等待至 linkTimeoutMs。
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => { if (args.includes('+messages-mget') && args.includes('om_1')) await gate.promise; return lark })
  await h.runtime.settings.pause(true, 'panel')
  const a1 = feishu('1', '@bot 修 A'), b1 = feishu('2', '@bot 修 B'), b2 = feishu('3', '@bot B 还有这个', { root_id: 'om_2' })
  h.runtime.receive(a1); h.runtime.receive(b1)
  await h.runtime.settings.pause(false, 'panel')
  await waitUntil(() => linkLookedUp('om_1'))
  h.runtime.receive(b2)
  gate.resolve(); await h.runtime.idle()
  const threadB = `feishu:${CHAT}:om_2`
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b1.id] }, pending: [b2.id] })
  await h.route({ kind: 'ignore', trigger_id: b1.id, reason: 'duplicate' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b2.id] }, pending: [] })
  // 缓慢的链接查询只挂起自己候选的卡片。
  expect(h.candidates()).toEqual([b1.id, a1.id, b2.id])
})

it('较早工单的投递还在等待时，用户已停止的工单不接收任何投递', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  h.runtime.receive(feishu('6', '二的补充', { mentions: [], root_id: 'om_5', sender_id: 'ou_guest' }))
  // 工单按从新到旧处理，因此挂起工单二会在投递工单一之前暂停这一轮 pass。
  const gate = deferred()
  const held = holdSession(two.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ ended: { by: 'human' }, undelivered: [] })
})

it('投递还在等待执行器 Session 时用户停止了其工单，投递随之丢弃', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  const gate = deferred()
  const held = holdSession(one.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).not.toHaveProperty('delivery')
})

it('prepare 命令在后台并行运行，接受、接收与 pass 照常进行', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR"' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const prepares = () => h.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv[0] === 'sh').length
  const first = [feishu('1', '@bot 修一'), feishu('2', '@bot 修二')]
  for (const trigger of first) h.runtime.receive(trigger)
  await h.runtime.idle()
  for (const [index, trigger] of first.entries()) {
    const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${index}`, acknowledgement: '收到。' })
    expect(accepted).toMatchObject({ decision: 'accept', ticket: { state: 'working/queued' } })
  }
  await waitUntil(() => prepares() === 2)
  // 来源循环的下一条消息立即存储，两个 prepare 命令仍在运行时 pass 便转发它。
  const later = feishu('3', '@bot 修三')
  expect(h.runtime.receive(later)).toBe('stored')
  await h.runtime.pump()
  expect(h.candidates()).toEqual([...first, later].map(trigger => trigger.id))
  prepare.resolve()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list().map(ticket => ticket.assignments.at(-1)!.state)).toEqual(['running', 'running'])
})

it('被暂停打断的启动保持排队，处理恢复后完成', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'make worktree' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' })
  await waitUntil(() => h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === 'sh'))
  await h.runtime.settings.pause(true, 'panel')
  prepare.resolve(); await h.runtime.idle()
  const [ticket] = h.runtime.store.tickets.list()
  expect(ticket!.assignments).toEqual([expect.objectContaining({ state: 'pending' })])
  expect(h.runtime.effects.pending('launch')).toBe(true)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(ticket!.id)!.assignments).toEqual([expect.objectContaining({ state: 'running' })])
})

const botMessage = () => feishu('2', 'CI 失败', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' })
it('仅当有空闲槽位时才为机器人的输入唤醒空闲执行器 Session，并重新创建被删除的执行器 Session', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(botMessage()); await h.runtime.idle()
  // 工单二的执行器 Session 占用唯一的槽位，工单一的输入只好等待。
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  h.agents.get(two.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})

it('用户消息立即在限额之外的保留槽位中唤醒空闲执行器 Session', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})

it('进行中的启动计入 maxWorkers，因此给空闲执行器 Session 的机器人输入要等待槽位', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1, prepare: 'make worktree' } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  // 工单二的启动在其 prepare 命令运行期间（早于其执行器 Session）占用唯一槽位。
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  h.runtime.receive(feishu('5', '@bot 修二')); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: feishu('5', '').id, title: 'two', worktree_name: 'fix-two', acknowledgement: '收到。' })
  await waitUntil(() => h.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv[0] === 'sh').length === 2)
  h.runtime.receive(botMessage()); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  expect(h.agents.get(one.sessionId)!.status).toBe('idle')
  prepare.resolve(); await h.runtime.idle()
  const two = h.runtime.store.tickets.list().find(ticket => ticket.id !== one.ticket.id)!
  expect(h.agents.get(`worker-${two.id}`)!.status).toBe('running')
  // 槽位现在归工单二，工单一的输入仍要等待。
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
})

it('在工单上记录其执行器 Session 无法再次创建', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    if (id === one.sessionId) throw new Error('The Session store is offline')
    return h.resolveDefault(id)
  })
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ delivery: { error: expect.stringContaining('The Session store is offline') } })
})

it('执行器 Session 可在提供方暂时性失败后继续，最多三次，之后其工单失败', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  const fail = (error: unknown) => { h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error } as never) }
  const busy = Object.assign(new Error('Service Unavailable'), { status: 503 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fail(busy)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === one.sessionId).at(-1)!.text)
      .toContain('Your last turn failed for a passing reason')
    expect(latestAssignment(ticket())?.report).toBeUndefined()
  } finally { vi.useRealTimers() }
  fail(busy); fail(busy)
  expect(latestAssignment(ticket())?.report).toBeUndefined()
  // 第四次暂时性失败使工单失败，如同其他失败一样立即生效。
  fail(busy)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Service Unavailable') }))
})
describe('在暂时性失败后继续的执行器 Session', () => {
  const busy = () => Object.assign(new Error('Service Unavailable'), { status: 503 })
  const told = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === sessionId && call.text.includes('Your last turn failed for a passing reason'))
  it('回合像平常一样结束后重新计数暂时性失败', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const fail = () => { h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never) }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { fail(); fail(); fail(); await vi.advanceTimersByTimeAsync(60_000) } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(3)
    // 恢复的回合正常结束之后，再一次暂时性失败会重新开始重试计数，而不是算作连续第四次。
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    fail()
    await h.runtime.idle()
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
  })
  it('处理暂停期间等待，恢复后继续', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    agent.status = 'idle'
    await h.runtime.settings.pause(true, 'panel')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(told(one.sessionId)).toEqual([])
      await h.runtime.settings.pause(false, 'panel')
      await vi.advanceTimersByTimeAsync(5000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(1)
  })
  it('宿主在退避期内停止时丢弃其定时器', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error: busy() } as never)
      await h.runtime.stop()
      // 其定时器随执行器一起清除，因此不会读取已关闭的数据库。
      await vi.advanceTimersByTimeAsync(60_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toEqual([])
  })
})
describe('工作在后台运行的执行器 Session', () => {
  /** 执行器 Session 保存的最后发言。 */
  const said = (sessionId: string, text: string) => {
    (h.agents.get(sessionId) as unknown as { session: { snapshotEvents: () => unknown[] } }).session.snapshotEvents =
      () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }]
  }
  const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)
  it('shell 作业运行期间保持占用（保留其槽位），作业结束且回合结束后报告 waiting', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    // 作业运行期间没有 waiting 报告，也不转发任何内容；下一个工单等待作业占用的槽位。
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(latestAssignment(h.runtime.store.tickets.get(two.ticket.id)!)).toMatchObject({ state: 'pending' })
    // 作业结束并携结果唤醒执行器 Session；其回合结束，随后报告 waiting。
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('子 agent 工作期间保持占用，其结束唤醒的回合结束后报告 waiting', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const child = h.subagents.spawn(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    h.subagents.settle(child)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('工单停止时终止其 shell 作业并释放其子 agent，两者的结束不唤醒任何人，之后仍可启动新的', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    h.runtime.engine.stopTicket(one.ticket.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalledWith(agent, [child]))
    // 终止操作的结束释放了停止操作自身的等待，DSH 以此告知执行器 Session 的作业工具它已被收集；被释放的子
    // agent 的结束（DSH 在释放返回之前投递）连同它唤醒的回合一起被丢弃。
    expect(h.jobs.released).toBe(1)
    await vi.waitFor(() => expect(agent.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder[0]!))
    expect(agent.cancel).toHaveBeenLastCalledWith({ kind: 'user' }, { keepInbox: false })
    // 其 Session 仍可接纳子 agent，如同工单恢复时那样。
    expect(() => h.subagents.spawn(one.sessionId)).not.toThrow()
  })
  it('对替代前一个派工的新派工报告 waiting，前者的空闲仍在等待其子 agent', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // 第一个派工的回合在其子 agent 工作期间结束。
    const child = h.subagents.spawn(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    // 投递用户消息失败，用户重试：子 agent 被释放，第二个派工启动。
    h.runtime.engine.deliveryFailed(one.ticket.id, latestAssignment(ticket())!.id, 'Session busy')
    h.runtime.engine.retryTicket(one.ticket.id); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())).toMatchObject({ state: 'running' }))
    expect(h.subagents.live(child)).toBe(false)
    // 第二个派工的回合结束：它被报告为 waiting。
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    expect(ticket().assignments).toHaveLength(2)
  })
  /**
   * 用 `report` 交接给用户的执行器 Session 会释放其槽位并停止其子 agent；其作业（为用户运行的服务器）继续运行，
   * 它的结束不唤醒任何人。
   */
  async function handsOff(report: Record<string, unknown>, before?: (ticketId: string) => void) {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    before?.(one.ticket.id)
    const job = h.jobs.run(one.sessionId, 'pnpm dev'), child = h.subagents.spawn(one.sessionId)
    await h.runTool(one.sessionId, 'orchestrator_report', report); await h.runtime.idle()
    const relayed = h.relays(h.runtime.masterId).length
    idle(one.sessionId); await h.runtime.idle()
    // 子 agent 停止，其结束唤醒的回合被取消；作业的结束被收集。
    await vi.waitFor(() => expect(h.subagents.live(child)).toBe(false))
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('idle'))
    expect(h.jobs.service.wait).toHaveBeenCalledWith(job, expect.any(Number), one.sessionId, expect.anything())
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('idle')
    expect(h.jobs.released).toBe(1)
    // 执行器 Session 在下一个回合读到该结束通知。
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.inject).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: `Your background job ${job} (pnpm dev) ended: completed.` })] })))
    await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toMatchObject({ state: report.state })
    return one
  }
  it('报告 blocked 的执行器 Session 释放槽位，停止其子 agent 并保留其作业，作业结束不唤醒任何人', async () => {
    await handsOff({ state: 'blocked', summary: 'Which color?' })
  })
  it('失败的执行器 Session 不被其留下的作业唤醒，也不会再次失败', async () => {
    await handsOff({ state: 'failed', summary: 'The build broke.' })
  })
  it('在跟随其 PR 的工单上报告 ready 的执行器 Session 释放槽位', async () => {
    await handsOff({ state: 'ready', summary: 'PR ready' }, ticketId => { h.runtime.engine.bindThread(ticketId, { source: 'github', id: '7' }, true) })
  })
  it('用 progress 报告向用户提问的执行器 Session 释放槽位', async () => {
    await handsOff({ state: 'progress', summary: 'The server runs.', human_action: 'Does the button look right?' })
  })
  it('交接后，用户在该执行器 Session 中发起回合的后台工作保留在 Session 中', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' }); await h.runtime.idle()
    // 用户在执行器 Session 中回答（工单不记录这一步）；该回合启动了一个子 agent 和一个作业。
    await new Promise(resolve => setTimeout(resolve, 5))
    h.ctx.emit('agent/inbox/claimed', { agent, message: { id: 'typed', role: 'user', content: [], source: { kind: 'user' } }, turn: 2 } as never)
    const child = h.subagents.spawn(one.sessionId), job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    // 它们让执行器 Session 保持占用，如同任何回合的后台工作一样。
    expect(h.subagents.live(child)).toBe(true)
    expect(h.jobs.service.wait).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.subagents.settle(child); h.jobs.end(job)
    expect(agent.status).toBe('running')
  })
  it('执行器 Session 留给用户的作业不计入后续回合的后台工作，到达上限时也不终止它们', async () => {
    const one = await handsOff({ state: 'ready', summary: 'PR ready' }, ticketId => { h.runtime.engine.bindThread(ticketId, { source: 'github', id: '7' }, true) })
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // 又留下第二个服务器；随后一条来自 orchestrator 的备注唤醒执行器 Session，其回合结束但没有报告。
    const server = h.jobs.run(one.sessionId, 'pnpm preview')
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Preview up' }); await h.runtime.idle()
    idle(one.sessionId); await h.runtime.idle()
    await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(server, expect.any(Number), one.sessionId, expect.anything()))
    await new Promise(resolve => setTimeout(resolve, 5))
    h.runtime.engine.note(one.ticket.id, 'CI passed on the pull request.'); await h.runtime.idle()
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('running'))
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(0)
  })
  it('把执行器 Session 回合的每次结束记录到其派工上，ready 报告之后也一样', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report!
    await new Promise(resolve => setTimeout(resolve, 5))
    idle(one.sessionId); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.idleAt! > report.at).toBe(true))
  })
  it('执行器 Session 再次工作时的运行中派工不显示回合结束，无论记录过多少次回合结束', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'On it again' })
    const page = await h.api('GET', `tickets/${one.ticket.id}`)
    expect((page.body as { assignments: Record<string, unknown>[] }).assignments[0]).not.toHaveProperty('turnEndedAt')
  })
  it('合并时，执行器 Session 在后台处理其已确认的消息期间工单保持打开', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    idle(one.sessionId); await h.runtime.idle()
    // 用户要求更多；执行器 Session 确认后在后台开始工作，随后回合结束。
    await new Promise(resolve => setTimeout(resolve, 5))
    const more = feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    await vi.waitFor(() => expect(ticket().undelivered).toEqual([]))
    await h.runTool(one.sessionId, 'orchestrator_ack', { trigger_id: more.id, text: '收到' })
    h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    expect(ticket().ended).toBeUndefined()
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
  })
  it('消息到达已 ready 的工单后，执行器 Session 继续忙于自己启动的工作', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // 工单跟随其 PR，因此 ready 报告让它保持打开。
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' })
    idle(one.sessionId); await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    // 用户要求更多；执行器 Session 在后台启动测试并结束其回合。
    await new Promise(resolve => setTimeout(resolve, 5))
    h.runtime.receive(feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())?.deliveredAt! >= latestAssignment(ticket())!.report!.at).toBe(true))
    const job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.jobs.end(job); idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('执行器 Session 的每次空闲各有 30 分钟，后台工作结束唤醒的回合不计入', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const first = h.jobs.run(one.sessionId)
    let second = ''
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      idle(one.sessionId)
      await minutes(20)
      // 作业结束并唤醒执行器 Session，它又启动一个，5 分钟后结束其回合。
      h.jobs.end(first)
      second = h.jobs.run(one.sessionId)
      await minutes(5)
      idle(one.sessionId)
      // 距第一次空闲 35 分钟，距第二次 10 分钟。
      await minutes(10)
      expect(h.jobs.service.kill).not.toHaveBeenCalled()
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(20)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(second, one.sessionId, expect.any(String)))
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
  })
  it('回合结束 30 分钟后仍在运行的作业被终止，其子 agent 保留，报告 waiting 排在其发言之后', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    said(one.sessionId, 'The tests run in the background.')
    const job = h.jobs.run(one.sessionId, 'pnpm test\n  --watch=false'), child = h.subagents.spawn(one.sessionId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      idle(one.sessionId)
      await minutes(29)
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(1)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'waiting', summary: 'The tests run in the background.\n\n'
      + `Background jobs ran 30 minutes after the worker's turn ended and were killed: ${job} (pnpm test).` }))
    expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String))
    // 终止操作已被收集，执行器 Session 在下一个回合读到它。
    expect(h.agents.get(one.sessionId)!.inject).toHaveBeenCalledWith(expect.objectContaining({ content: [expect.objectContaining({
      text: `Your background jobs ran 30 minutes after your turn ended and were killed: ${job} (pnpm test).` })] }))
    // 停止其子 agent 会带着结束通知唤醒它，而它刚在对应派工中被报告为 waiting。
    expect(h.subagents.live(child)).toBe(true)
    expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'waiting' })
  })
  it('只有子 agent 在回合结束 30 分钟后仍在运行时，报告说明子 agent 仍在运行', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.subagents.spawn(one.sessionId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { idle(one.sessionId); await minutes(30) } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toMatchObject({ state: 'waiting',
      summary: 'Subagents still ran 30 minutes after the worker\'s turn ended.' }))
  })
  it('交接停止子 agent 期间到达执行器 Session 的投递被挂起，直到停止结束', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    h.subagents.spawn(one.sessionId)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // 用户消息正在进入执行器 Session 的途中并被挂起，此时执行器 Session 交接；释放很慢。
    const session = deferred(), drain = deferred(), release = h.subagents.service.drainChildren.getMockImplementation()!
    h.subagents.service.drainChildren.mockImplementationOnce(async (parent, ids) => { await drain.promise; await release(parent, ids) })
    await new Promise(resolve => setTimeout(resolve, 5))
    const held = holdSession(one.sessionId, session.promise)
    h.runtime.receive(feishu('2', '按钮再大一点', { mentions: [], root_id: 'om_1' }))
    await vi.waitFor(() => expect(held()).toBe(true))
    idle(one.sessionId)
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalled())
    session.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    drain.resolve()
    // 消息在停止的 cancel 之后到达执行器 Session——若顺序相反它会被丢弃。
    const message = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('按钮再大一点') })
    await vi.waitFor(() => expect(h.deliveries).toHaveBeenCalledWith(message), { timeout: 5000 })
    const delivered = h.deliveries.mock.calls.findIndex(([call]) => call.sessionId === one.sessionId && call.text.includes('按钮再大一点'))
    expect(h.deliveries.mock.invocationCallOrder[delivered]).toBeGreaterThan(agent.cancel.mock.invocationCallOrder.at(-1)!)
  })
  it('保留重启发现的已交接给已稳定执行器 Session 的输入，并在其子 agent 停止后投递等待中的输入', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!, ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    // 一个子 agent 仍在运行且释放缓慢；一条输入在 Session 收件箱中等待，另一条在工单上。
    h.subagents.spawn(one.sessionId)
    const gate = deferred(), drain = h.subagents.service.drainChildren.getMockImplementation()!
    h.subagents.service.drainChildren.mockImplementationOnce(async (parent, ids) => { await gate.promise; await drain(parent, ids) })
    agent.inbox.nextStep.push({ id: 'taken-later', role: 'user', content: [{ type: 'text', text: 'Handed over' }], source: { kind: 'user' } } as never)
    const stored = ticket()
    stored.inputs.push({ id: 'input-late', kind: 'text', text: 'One more thing', at: new Date().toISOString() })
    stored.undelivered.push('input-late')
    h.runtime.store.tickets.save(stored)
    // 投递等待释放完成，effects 在此之前不会空闲。
    h.runtime.executor.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    const late = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('One more thing') })
    expect(h.deliveries).not.toHaveBeenCalledWith(late)
    const reports = () => h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report').length
    const reported = reports()
    gate.resolve()
    await vi.waitFor(() => expect(h.deliveries).toHaveBeenCalledWith(late))
    expect(agent.cancel).not.toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.inbox.nextStep.map(message => message.id)).toContain('taken-later')
    // 子 agent 结束唤醒、又被释放取消的回合不报告任何内容。
    await h.runtime.idle()
    expect(reports()).toBe(reported)
  })
  it('收集留给用户的作业的结束通知，直到 dsh-superagent-cn 停止其执行器 Session', async () => {
    const one = await handsOff({ state: 'blocked', summary: 'Which color?' })
    const agent = h.agents.get(one.sessionId)!
    const server = h.jobs.run(one.sessionId, 'pnpm dev')
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which size?' }); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(server, expect.any(Number), one.sessionId, expect.anything()))
    // 服务器在宿主停止期间（已取消各执行器 Session 之后）结束。
    const cancel = agent.cancel.getMockImplementation()!
    agent.cancel.mockImplementationOnce((...args: unknown[]) => { h.jobs.end(server); return cancel(...args as [unknown, { keepInbox?: boolean }]) })
    const woken = agent.followup.mock.calls.length
    await h.stop()
    expect(agent.followup.mock.calls.length).toBe(woken)
    expect(agent.status).toBe('idle')
  })
  it('dsh-superagent-cn 停止时先停止所有执行器 Session 的作业与子 agent，再释放它们的工具限额', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    await h.stop()
    expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String))
    expect(h.subagents.live(child)).toBe(false)
  })
  it('提前结束的子 agent 不取消任何执行器 Session；释放失败时同样取消被释放唤醒的回合', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    h.subagents.settle(h.subagents.spawn(one.sessionId))
    // 其 ready 报告结束工单，它也结束自己的回合。
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
    await h.runtime.idle(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.cancel).not.toHaveBeenCalled()
    // 结束通知唤醒执行器 Session 之后才失败的释放仍会取消那个回合。
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    const other = h.agents.get(two.sessionId)!
    const child = h.subagents.spawn(two.sessionId)
    h.subagents.service.drainChildren.mockImplementationOnce(async () => { h.subagents.settle(child); throw new Error('ACTIVATION_TEARDOWN_FAILED') })
    h.runtime.engine.stopTicket(two.ticket.id)
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalled())
    await vi.waitFor(() => expect(other.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder.at(-1)!))
  })
  it('停止本进程内重启遗留的执行器 Session 的作业与回合，之后其派工重新开始', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId)
    h.runtime.executor.resume()
    expect(h.agents.get(one.sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    expect(h.runtime.store.tickets.get(one.ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  })
  it('停止从未创建执行器 Session 的工单时不产生健康错误，并在终止失败后继续', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    await h.acceptedTicket(feishu('1', '@bot 修一'))
    const queued = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(h.agents.has(queued.sessionId)).toBe(false)
    // DSH 无法列出不存在的 Session 的子 agent。
    const list = h.subagents.service.listChildren.getMockImplementation()!
    h.subagents.service.listChildren.mockImplementation(async (id: string) => {
      if (id === queued.sessionId) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      return list(id)
    })
    h.runtime.engine.stopTicket(queued.ticket.id); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.runtime.health.worker?.state).not.toBe('error')
    // 抛错的终止不影响其他作业被继续终止。
    const one = h.runtime.store.tickets.list().find(ticket => ticket.id !== queued.ticket.id)!
    const sessionId = `worker-${one.id}`
    const [first, second] = [h.jobs.run(sessionId), h.jobs.run(sessionId)]
    h.jobs.service.kill.mockImplementationOnce(() => { throw new Error('No such process') })
    h.runtime.engine.stopTicket(one.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(second, sessionId, expect.any(String)))
    expect(h.jobs.service.kill).toHaveBeenCalledWith(first, sessionId, expect.any(String))
  })
})
describe('执行器 Session 读取了什么', () => {
  const later = () => new Promise(resolve => setTimeout(resolve, 5))
  /** 一个其执行器 Session 已完成的工单，以及其线程上用户的感谢——收到即恢复工单。 */
  async function completed() {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' }); await h.runtime.idle()
    idle(one.sessionId)
    await later()
    return { one, thanks: feishu('2', '@bot 谢谢', { root_id: 'om_1' }), ticket: () => h.runtime.store.tickets.get(one.ticket.id)! }
  }
  /** 对 Session 投递含 `text` 的消息一直失败，直到调用返回的函数放行。 */
  function failing(sessionId: string, text: string) {
    const agent = h.agents.get(sessionId)!, steer = agent.steer.getMockImplementation()!
    let fail = true
    agent.steer.mockImplementation(message => {
      if (fail && message.content.some(block => block.type === 'text' && block.text.includes(text))) throw new Error('Session busy')
      steer(message)
    })
    return () => { fail = false }
  }
  /** 在投递重试（两秒后）之后运行 `then`；时钟只随 `vi.setSystemTime` 前进。 */
  async function retried(then: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
    try { await h.runtime.pump(); await h.runtime.idle(); await then(); await h.runtime.pump(); await h.runtime.idle() }
    finally { vi.useRealTimers() }
  }
  it('在 dropped 报告时，把唤醒了工单、且重试在 progress 报告之后送达的消息送评估', async () => {
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    expect(ticket().delivery).toBeDefined()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Looking' })
    pass()
    // 重试把消息送入时执行器 Session 正写着没有剩余工作，且之前没有任何步骤接收它。
    await retried(async () => {
      expect(ticket().undelivered).toEqual([])
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).toContain(thanks.id)
  })
  it('送达的消息只有在其步骤把它带入 Session 后才算已读，被截断步骤认领时不算', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const input = () => h.runtime.store.tickets.get(one.ticket.id)!.inputs.find(item => item.kind === 'trigger' && item.triggerId === more.id) as
      { readAt?: string | null }
    await vi.waitFor(() => expect(input().readAt).toBe(null))
    // 步骤认领了它却在 Session 接收之前被截断——如同其前置步骤中的 cancel，消息随之丢弃。
    h.claim(one.sessionId); await h.runtime.idle(); await later()
    expect(input().readAt).toBe(null)
  })
  it('备注跨进程内重启在执行器 Session 中等待，供下一个派工的第一步处理', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.note(one.ticket.id, 'Ticket B changes the same page.'); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('Ticket B changes the same page.'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    const claimed: string[] = []
    h.ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id) })
    // 重启取消执行器 Session 的回合并保留其收件箱，备注在那里等待。
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(claimed).toContain(copies()[0]![0].id))
    expect(copies()).toHaveLength(1)
  })
  it('崩溃遗留在执行器 Session 中等待的消息只投递一次，重启把它放回供下一个派工使用', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    // 进程死亡：重启运行时执行器 Session 的 agent 尚未加载，其收件箱（保存着这条消息）
    // 会为加载它的启动持久保留。
    const agent = h.agents.get(one.sessionId)!
    h.agents.delete(one.sessionId); agent.status = 'idle'
    h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === one.sessionId) h.agents.set(id, agent); return h.resolveDefault(id) })
    const waiting: string[][] = [], launch = agent.followup.getMockImplementation()!
    agent.followup.mockImplementation(message => { waiting.push([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id)); launch(message) })
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(copies()).toHaveLength(2))
    // 启动时的消息没有发现任何等待中的副本；其步骤会接收它，与稍后送达的副本并列。
    expect(waiting[0]).not.toContain(copies()[0]![0].id)
  })
  it('进程内重启启动的派工收到被截断步骤认领过的消息，只一次', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const sent = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下')).length
    await vi.waitFor(() => expect(sent()).toBe(1))
    // 步骤认领了它，重启在 Session 接收之前截断该步骤，消息因此被丢弃。
    h.claim(one.sessionId)
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(sent()).toBe(2))
    await h.runtime.idle(); await later()
    expect(sent()).toBe(2)
  })
  it('唤醒工单的消息在其执行器 Session 的步骤接收后，由稍后的 dropped 报告计为已读', async () => {
    const { one, thanks } = await completed()
    // 恢复的派工消息唤醒执行器 Session；其下一步接收恢复备注与该消息。
    h.runtime.receive(thanks); await h.runtime.idle()
    h.step(one.sessionId)
    await later()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.candidates()).not.toContain(thanks.id)
  })
  it('重试送达给空闲执行器 Session 的消息，由其唤醒回合的报告计为已读', async () => {
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    pass()
    // 重试唤醒执行器 Session，其第一步接收该消息。
    await retried(async () => {
      expect(h.agents.get(one.sessionId)!.status).toBe('running')
      vi.setSystemTime(Date.now() + 1000)
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).not.toContain(thanks.id)
  })
  it('合并时把在其最后一步之后到达执行器 Session 的消息送评估——回合结束前没有任何步骤接收它', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // 用户的感谢在其报告步骤之后到达执行器 Session，回合结束前没有步骤接收它。
    await later()
    const thanks = feishu('2', '@bot 谢谢', { root_id: 'om_1' })
    h.runtime.receive(thanks); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    await later()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    await h.runtime.pump(); await h.runtime.idle()
    expect(ticket().ended).toMatchObject({ outcome: 'merged' })
    expect(h.candidates()).toContain(thanks.id)
  })
})
it('执行器 Session 在退避等待期间回合结束时，不报告任何内容', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  const relayed = h.relays(h.runtime.masterId).length
  h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Service Unavailable'), { status: 503 }) } as never)
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
  expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
})
it('其他槽位全被占用时，状态请求在为用户保留的槽位中唤醒空闲执行器 Session', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // 其执行器 Session 结束回合时没有报告，因此处于等待。
  h.agents.get(one.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.agents.get(one.sessionId), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  expect(h.runtime.engine.requestStatus(one.ticket.id)).toBe(true); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})
it('区分提供方或网络的暂时性失败与再次尝试仍会遇到的失败', () => {
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }),
    Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed'), new Error('getaddrinfo EAI_AGAIN api.example.com')]) {
    expect(transient(error)).toBe(true)
  }
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'LlmError: offline']) {
    expect(transient(error)).toBe(false)
  }
})
it('用户回答其 blocked 报告之后回合结束时，执行器 Session 被报告为 waiting', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' })
  // 用户晚于报告回答。
  await new Promise(resolve => setTimeout(resolve, 5))
  h.runtime.receive(feishu('2', '蓝色', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  expect(waitsForPerson(ticket())).toBe(false)
  h.agents.get(one.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.agents.get(one.sessionId), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
})

it('暂停解除后恢复用户在暂停期间写信的已结束工单，按当时的策略执行', async () => {
  const pass = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  const ended = async (id: string) => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu(id, `@bot 修${id}`, { root_id: `om_${id}` }))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    return ticket.id
  }
  const first = await ended('1'), second = await ended('3')
  const followUp = async (id: string, root: string) => {
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: root })); await h.runtime.idle()
  }
  // 处理暂停期间消息在已结束工单上等待；暂停后的第一次 pass 恢复工单。
  await followUp('2', 'om_1')
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ ended: expect.anything(), undelivered: [expect.any(String)] })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'running' })] })
  expect(h.runtime.store.tickets.get(first)).not.toHaveProperty('ended')
  // 暂停解除时策略不再支持的授权不会恢复：其发送者在此期间离开了名单。
  await followUp('4', 'om_3')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(second)).toMatchObject({ ended: expect.anything(), undelivered: [] })
})

it('只有结束其派工的停止提交后才结束执行器 Session 的回合', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.agents.get(one.sessionId)! as unknown as { cancel: ReturnType<typeof vi.fn> }
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(one.ticket.id); throw new Error('rolled back') })).toThrow('rolled back')
  expect(worker.cancel).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.ended).toBeUndefined()
  h.runtime.engine.stopTicket(one.ticket.id)
  expect(worker.cancel).toHaveBeenCalledOnce()
})

describe('执行器的组成部件', () => {
  it('为每个运行中或启动中的工单各占一个槽位，启动可以占用执行器 Session 与唤醒未持有的槽位', () => {
    const running = ['t1']
    const slots = new WorkerSlots(() => running, () => 3)
    slots.reserve('t2', 'launch')
    slots.reserve('t3', 'wake')
    expect(slots.used()).toBe(3)
    // launches() 不计入 'launch' 预约，因为启动队列单独跟踪进行中的启动。
    expect(slots.launches()).toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    expect(() => slots.reserve('t3', 'wake')).not.toThrow()
    slots.free('t3')
    expect(slots.used()).toBe(2)
    slots.reserve('t4', 'launch')
    expect(slots.used()).toBe(3)
  })
  it('在限额之外的唯一槽位中为用户消息唤醒执行器 Session，槽位释放后优先于启动', () => {
    const running = ['t1', 't2', 't3']
    const slots = new WorkerSlots(() => running, () => 3)
    expect(() => slots.reserve('t4', 'launch')).toThrow(Later)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    slots.reserve('t5', 'person')
    expect(slots.used()).toBe(4)
    expect(slots.launches()).toBeLessThanOrEqual(0)
    // 限额之外放不下第二个用户唤醒；执行器 Session 结束后就可以，启动则仍需等待。
    expect(() => slots.reserve('t6', 'person')).toThrow(Later)
    running.splice(0, 1)
    expect(() => slots.reserve('t7', 'launch')).toThrow(Later)
    slots.reserve('t6', 'person')
    expect(slots.used()).toBe(4)
  })
  it('仅凭工单本身组织派工文本以及 inferred 授权设定的限制', () => {
    const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true,
      instruction: 'Fix typos only.' }] } })
    const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
      mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy'] }, actor: { source: 'github', id: 'alice' },
        scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never,
      settings, '/state')
    expect(execution).toEqual(expect.objectContaining({ name: 'fix-typo-ticket-01234' }))
    expect(execution).not.toHaveProperty('session')
    // 来源触发随派工附带，因此文本不再指向它。
    expect(execution.assignment).toContain('Scope: the typo.')
    expect(execution.assignment).not.toContain('trigger/tr1')
    expect(ticketExecution({ ...ticket, mandate: { ...ticket.mandate, strength: 'explicit' } } as Ticket,
      { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'r', name: 'fix-login', note: 'the login page' } as never, settings, '/state').assignment)
      .toBe('Routing note (not the source request): the login page')
    // 执行器 Session 的系统 prompt 保存 inferred 授权设定的限制，派工文本因此不再重复。
    expect(execution.assignment).not.toContain(mandateInstructions(ticket.mandate))
    expect(execution.assignment).toContain('- Copy fixes (copy): Fix typos only.')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })
  it('按执行器 Session 的读取方式内联渲染每种输入，并排除 reopen 输入', () => {
    const asked = { id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Which page?', meta: {} } as Trigger
    const reply = { ...asked, id: 'tr2', text: 'The login page. '.repeat(50) }
    const card = triggerMessage(reply, { source_url: 'https://x' }, 'see the log', asked)
    expect(card).toEqual({ trigger_id: 'tr2', from: 'ou_a', thread: 'feishu:oc:om_1', at: '2026-09-01T00:00:00Z', text: expect.stringMatching(/^The login page\./),
      chars: reply.text.length, read: 'trigger/tr2', source_url: 'https://x', routing_note: 'see the log', replies_to: { trigger_id: 'tr1', preview: 'Which page?' } })
    expect(card.text).toHaveLength(601)
    expect(triggerMessage(asked, {})).toEqual({ trigger_id: 'tr1', from: 'ou_a', thread: 'feishu:oc:om_1', at: asked.at, text: 'Which page?' })
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '' }, card)!)).toEqual(card)
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'gone', at: '' })!)).toEqual({ trigger_id: 'gone', read: 'trigger/gone' })
    expect(inputMessage({ id: 'i2', kind: 'text', at: '', text: 'Please also update the docs' })).toBe('Please also update the docs')
    // 策略变更说明其对工单的影响，不含版本哈希。
    const changed = inputMessage({ id: 'i3', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { requesterAllowed: false,
      requester: { source: 'github', id: 'ci-bot' },
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }, { id: 'visual', name: 'Visual', change: 'disabled' }] } })!
    expect(changed).toContain('Rule Copy fixes (copy), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Fix typos only.')
    expect(changed).toContain('Rule Visual (visual), which this ticket was accepted under, no longer applies')
    // 发送者被指名，机器人按用户称谓。
    expect(changed).toContain('The sender this ticket is for, ci-bot on github, may no longer start work here')
    expect(changed).not.toContain('person')
    expect(changed).not.toContain('v2')
    const mode = inputMessage({ id: 'i6', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { proactive: false } })!
    expect(mode).toContain('Work inferred from a rule is no longer accepted, as the accept mode is no longer auto')
    expect(mode).not.toContain('sender')
    expect(inputMessage({ id: 'i5', kind: 'resumed', at: '', triggerId: 'tr2' })).not.toContain('tr2')
    expect(inputMessage({ id: 'i4', kind: 'reopen', at: '' } as never)).toBeUndefined()
  })
  it('把执行器 Session 的问题、结果或回答转发给主 Session，进度则保持内部', () => {
    const ticket = { id: 't1', title: 'Fix', updatedAt: '2026-09-01T00:00:00Z', attention: { id: 'a1', question: 'Which color?' }, assignments: [],
      mandate: { strength: 'explicit' }, origin: { triggerId: 'tr1' } } as unknown as Ticket
    expect(reportRelay(ticket, { state: 'progress', summary: 'halfway' })).toBeUndefined()
    expect(reportRelay(ticket, { state: 'blocked', summary: 'need input', question: 'Which color?' }))
      .toMatchObject({ id: 'attention:t1:a1', text: expect.stringContaining('"kind":"worker_attention"') })
    const ready = reportRelay({ ...ticket, attention: undefined } as unknown as Ticket, { state: 'ready', summary: 'Done',
      answers: 'tr9' })!
    expect(ready.id).toMatch(/^report:/)
    expect(JSON.parse(ready.text)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: 't1' }, trigger_id: 'tr1', state: 'ready', answer_to: 'tr9', summary: 'Done' })
  })
})

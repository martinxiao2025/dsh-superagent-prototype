/**
 * follow-up 路由：已订阅 thread 上的人类消息直接交给 ticket 的 worker，并以通知告知主会话而不启动 Eval；
 * 交回的 trigger 作为 candidate 回到主会话，只有从面板重新排队或交回之后才重新评估。
 */
import { afterEach, expect, it } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const THREAD = `feishu:${CHAT}:om_1`
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1', ...overrides })
const notices = (host: Host) => host.notices().filter(item => item.kind === 'follow_up')

it('delivers a follow-up to the worker and tells the main Session, without an Eval', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  const message = followup('2', '顺便把标题也改了', { parent_id: 'om_1' })
  h.runtime.receive(message)
  await h.settle()
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: message.id, text: '顺便把标题也改了' })])
  // 主会话收到的是一份 relay：谁把它交出去的、它送到了哪些工单，以及它只应被用来停止工作。
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'follow_up')).toEqual([expect.objectContaining({ kind: 'follow_up',
    trigger_id: message.id, from: 'ou_alice', thread: THREAD, text: '顺便把标题也改了',
    delivered_to: [expect.objectContaining({ ticket_id: ticket.id })], note: expect.stringContaining('该工单的 worker 已接手并自行决定') })])
  // 没有 candidate、没有 Eval：thread 的队列保持空闲。
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(h.runtime.store.threads.get(THREAD)).not.toHaveProperty('evaluating')
  expect(h.runtime.store.triggers.disposition(message.id)).toEqual({ fanout: [ticket.id], at: expect.any(String) })
})

it('sends a person\'s message that reaches no ticket, such as one a person stopped, to Eval as before', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.stopTicket(ticket.id)
  h.deliveries.mockClear()
  const message = followup('2', '@bot 换个方式修', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(message)
  await h.settle()
  expect(notices(h)).toEqual([])
  expect(h.candidates()).toEqual([message.id])
})

it('lets a worker hand a follow-up back as a candidate, and only then can the main Session route it', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '另外把导出按钮也加上')
  h.runtime.receive(message)
  await h.settle()
  const decides = /由该工单的 worker 决定它是否属于那里/
  await expect(h.route({ kind: 'accept', trigger_id: message.id, title: 'More', worktree_name: 'more', acknowledgement: 'ok' }))
    .rejects.toThrow(decides)
  expect(await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id, reason: 'It asks for an export button.' }))
    .toEqual({ trigger_id: message.id, queued: true })
  await h.runtime.pump(); await h.settle()
  expect(h.candidates()).toContain(message.id)
  expect(h.relays(h.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === message.id))
    .toMatchObject({ strength: 'explicit', handed_back: [{ trigger_id: message.id, ticket_id: ticket.id, reason: 'It asks for an export button.' }] })
  // 交回之后主会话才能接受它。
  expect(await h.route({ kind: 'accept', trigger_id: message.id, title: '导出按钮', worktree_name: 'export', acknowledgement: '收到。' }))
    .toMatchObject({ ticket: expect.objectContaining({ ticket_id: expect.any(String) }) })
  await h.settle()
  expect(h.runtime.store.tickets.get(ticket.id)!.mandate).toMatchObject({ strength: 'explicit' })
  // 已交回的 trigger 不会被再次交回。
  await expect(h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id, reason: 'Again' }))
    .rejects.toThrow(/该工单已经把那个 Trigger 交回了/)
})

it('lets a worker follow a related thread for context, and notes the ticket without waking the main Session', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:7', reason: 'The issue it fixes.' }))
    .toEqual({ followed: true, thread: 'github:7' })
  await h.settle()
  expect(h.runtime.store.threads.get('github:7')).toMatchObject({ subscriptions: [expect.any(String)] })
  // 通知留在主会话的待注入队列里，不派发回合。
  expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === h!.runtime.masterId)).toEqual([])
  expect(h.notices()).toEqual(expect.arrayContaining([expect.objectContaining({ thread_followed: expect.objectContaining({ thread: 'github:7' }) })]))
})

/**
 * 集成测试：真实 Runtime 在有宿主替身时的启动、面板 API、工单派发与 transcript、暂停与恢复、
 * worker 失败上报，以及关停。模型回合由 `FakeAgentHost` 承担，其余都是生产代码。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { ticketCard } from '../src/app/cards.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('starts configured, reports its accounts and health, and lists empty state', async () => {
  h = await startRuntime()
  expect((await h.api('GET', 'state')).body).toMatchObject({ setup: expect.objectContaining({ problem: null,
    accounts: expect.objectContaining({ repository: 'acme/widgets', agent: 'agent-bot' }) }), masterId: h.runtime.masterId })
  expect((await h.api('GET', 'tickets')).body).toMatchObject({ items: [] })
  expect(h.runtime.health).toMatchObject({ runtime: { state: 'ready' }, panel: { state: 'ready' } })
})

it('accepts a ticket, dispatches it to a worker with its environment, and records the transcript', async () => {
  h = await startRuntime()
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  expect(h.candidates()).toEqual([trigger.id])
  const { ticket } = await h.acceptedTicket(trigger)
  // worker 结束首轮但没有汇报状态，执行器因此记为 waiting，卡片显示 idle。
  expect(ticketCard(h.runtime.store.tickets.get(ticket.id)!).state).toBe('idle')
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running', report: { state: 'waiting' } })
  // worker 收到第一条 Assignment 消息，其中带有工单目录与来源 trigger。
  const request = h.host.requests.find(item => item.sessionId === `worker-${ticket.id}`)!
  expect(request.prompt).toContain('修一下回归')
  expect(request.directory).toBe(ticket.execution!.directory)
  expect(request.directory).toContain('fix-regression')
  expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['orchestrator_report', 'orchestrator_read']))
  // 两个方向的消息都写进 transcript，供面板与 orchestrator_read 读取。
  expect(h.runtime.store.get(KV.transcript(ticket.id))).toEqual([
    expect.objectContaining({ type: 'user/message' }), expect.objectContaining({ type: 'assistant/message' })])
  const list = (await h.api('GET', 'tickets')).body as { items: { id: string }[] }
  expect(list.items.map(item => item.id)).toContain(ticket.id)
})

it('turns a worker report into a ready ticket', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  await h.settle()
  expect(ticketCard(h.runtime.store.tickets.get(ticket.id)!).state).toBe('completed')
  expect((await h.api('GET', 'tickets?state=open')).body).toMatchObject({ items: [] })
})

it('stops evaluating while paused and resumes the queued trigger afterwards', async () => {
  h = await startRuntime()
  await h.api('POST', 'executor/pause', { paused: true })
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger)
  await h.settle()
  expect(h.candidates()).toEqual([])
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.candidates()).toEqual([trigger.id])
})

it('reports a failed worker turn as a waiting ticket and keeps the runtime available', async () => {
  h = await startRuntime()
  h.host.hold()
  const { ticket, sessionId } = await h.accept(feishu('1', '@bot 修一下回归'))
  await vi.waitFor(() => { expect(h!.host.requests.some(item => item.sessionId === sessionId)).toBe(true) })
  h.host.fail(sessionId, '模型不可用')
  h.host.auto = true
  await vi.waitFor(() => { expect(h!.runtime.store.tickets.get(ticket.id)!.delivery).toMatchObject({ error: expect.stringContaining('模型不可用') }) })
  expect(ticketCard(h.runtime.store.tickets.get(ticket.id)!).state).toBe('person/delivery')
  expect(h.runtime.store.get(KV.transcript(ticket.id))!.at(-1)).toMatchObject({ message: expect.objectContaining({
    content: [expect.objectContaining({ text: expect.stringContaining('[回合失败] 模型不可用') })] }) })
  // 单轮失败只影响该工单；宿主与运行时仍可用。
  expect(h.runtime.health.worker).toMatchObject({ state: 'ready' })
  expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })
})

it('stops idempotently, stopping the host and closing the panel', async () => {
  h = await startRuntime()
  const stop = vi.spyOn(h.host, 'stop')
  await Promise.all([h.runtime.stop(), h.runtime.stop()])
  expect(stop).toHaveBeenCalledTimes(1)
  expect(h.host.state).toBe('stopped')
  h = undefined
})

// @vitest-environment jsdom
// 触发页状态与线程详情。
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, click, text, at } from './fixtures/panel.tsx'
import { server, trigger, threadSummary, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
it('从新到旧浏览线程时间线，处置显示为标签并列出其决定；重新入队被过滤的触发，可向前翻页并返回', async () => {
  await mount()
  await click(zh['tab.trigger'])
  expect(document.querySelector('.dt-ticket .dt-stage')?.textContent).toBe(zh.threadSubscribed)
  expect(text()).toContain('扇出给 修复回归')
  await click('这个文案好奇怪')
  expect(document.querySelector('.dt-page-head .dt-btn')?.textContent).toBe(zh['term.trigger'])
  expect(text()).not.toContain('扇出到 1 个工单')
  expect(text()).toContain('已过滤：发送者不在这个来源的名单里')
  expect(text()).toContain(zh['term.correlation'])
  expect(all('.dt-event .dt-event-text').map(element => element.textContent)).toEqual(['message e4', 'message e3'])
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e4/requeue')).toBe(true)
  expect(text()).toContain(zh.dispositionQueued)
  await click(zh.loadEarlier)
  expect(all('.dt-event .dt-event-text').map(element => element.textContent)).toEqual(['message e4', 'message e3', 'message e1'])
  await click(document.querySelector<HTMLElement>('.dt-page-head .dt-btn')!)
  expect(find(zh['threadFilter.subscribed'], '.dt-pill').getAttribute('aria-pressed')).toBe('true')
})

it('对到达工单的用户消息提供送评估入口，前提是其执行器 Session 既未处理也未交回', async () => {
  await mount()
  await click(zh['tab.trigger'])
  await click('这个文案好奇怪')
  const event = all('.dt-event').find(element => element.textContent?.includes('message e3'))!
  await click([...event.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === zh.requeue)!)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
})

it('按活跃度过滤线程列表，并在确认后从线程页退订', async () => {
  await mount()
  await click(zh['tab.trigger'])
  expect(find(zh['threadFilter.subscribed'], '.dt-pill').getAttribute('aria-pressed')).toBe('true')
  await click(zh['threadFilter.recent'])
  expect(server.requests.some(request => request.path === 'threads?filter=recent&limit=20')).toBe(true)
  expect(document.querySelector('select[aria-label="来源"]')).toBeNull()
  await click('这个文案好奇怪')
  await click(zh.unsubscribe)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'threads/feishu:oc_1:om_root/unsubscribe')).toBe(true)
})

it('折叠线程上同一发送者的连续自动消息，仅展示最新一条的文本', async () => {
  const bot = (id: string, at: string) => trigger(id, at, { actor: { source: 'github', id: '' }, human: false,
    text: `CI of PR #42 at abc1234: 3 checks, 0 failed, ${id === 'b3' ? 0 : 1} running.`, preview: `CI ${id}` })
  server.threadPages = () => ({ ...threadSummary(), tickets: [], correlated: [], decisions: [], earlier: null, context: [],
    timeline: [bot('b1', '2026-09-23T00:00:00Z'), bot('b2', '2026-09-23T00:01:00Z'), trigger('h1', '2026-09-23T00:02:00Z'), bot('b3',
      '2026-09-23T00:03:00Z'), bot('b4', '2026-09-23T00:04:00Z')] })
  await mount()
  await click(zh['tab.trigger'])
  await click('这个文案好奇怪')
  expect(all('.dt-event .dt-event-text').map(element => element.textContent)).toEqual(['CI of PR #42 at abc1234: 3 checks, 0 failed, 1 running.', 'message h1', 'CI of PR #42 at abc1234: 3 checks, 0 failed, 1 running.'])
  const folds = all('.dt-event').map(event => event.querySelector('button.dt-textlink[aria-expanded]')?.textContent ?? '')
  expect(folds).toEqual(['同一发送者之前还有 1 条自动消息', '', '同一发送者之前还有 1 条自动消息'])
  await click(find('同一发送者之前还有 1 条自动消息'))
  expect(text()).toContain('CI b3')
})

it('轮询最新页的同时，围绕链接目标只读取一次页面，对线程中没有的触发也是如此', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'trigger', id: 'feishu:oc_1:om_root', query: { trigger: 'gone' } })
  await mount()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path.startsWith('threads/')).map(request => request.path)).toEqual([
    'threads/feishu:oc_1:om_root?limit=50', 'threads/feishu:oc_1:om_root?limit=50&around=gone', 'threads/feishu:oc_1:om_root?limit=50'])
})

it('展示未经评估即送达工单的后续消息、附带原因的交回，以及仅作上下文跟随线程的工单', async () => {
  server.threadPages = () => ({ ...threadSummary(), tickets: [ticketSummary(), ticketSummary({ id: 't2', title: '相关工单' })],
    correlated: [], decisions: [], earlier: null, context: ['t2'], url: undefined,
    timeline: [trigger('f1', '2026-09-23T00:00:00Z', { disposition: { delivered: true, fanout: ['t1'] } }),
      trigger('f2', '2026-09-23T00:01:00Z', { disposition: { queued: true, fanout: ['t1'], handbacks: [{ ticketId: 't1', title: '修复回归',
        reason: 'Asks for a new page', at: '2026-09-23T00:02:00Z' }] } })] })
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await mount()
  const events = () => all('.dt-event').map(event => [event.querySelector('.dt-event-text')?.textContent,
    [...event.querySelectorAll('.dt-tag')].map(tag => tag.textContent), event.querySelector('.dt-hint')?.textContent])
  expect(events()).toEqual([['message f2', [zh.dispositionQueued], '“修复回归”的执行器把这条触发交回评估：Asks for a new page'],
    ['message f1', [zh.dispositionDelivered], undefined]])
  expect(document.querySelector(`.dt-tag[title="${zh.dispositionDeliveredHint}"]`)).not.toBeNull()
  expect(all('.dt-list .dt-ticket').map(row => [row.querySelector('.dt-open')?.textContent, row.querySelector('.dt-tag')?.textContent]))
    .toEqual([['修复回归', undefined], ['相关工单', zh.contextOnly]])
  await remount(en)
  expect(events()[1]).toEqual(['message f1', [en.dispositionDelivered], undefined])
  expect(events()[0]![2]).toBe('The Executor of “修复回归” handed it back for an Eval: Asks for a new page')
})

/** 模拟一个含 `count` 条间隔 1 分钟触发的线程，通过 `before` 或 `around` 游标每次分页 50 条。 */
function busyThread(count: number) {
  const minute = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString()
  const thread = { triggers: Array.from({ length: count }, (_, n) => trigger(`m${n}`, minute(n))),
    add: (more: number) => { const from = thread.triggers.length; thread.triggers.push(...Array.from({ length: more },
      (_, n) => trigger(`m${from + n}`, minute(from + n)))) } }
  server.threadPages = (_key, { before, around }) => {
    const end = around ? thread.triggers.find(item => item.id === around)?.at : undefined
    const kept = thread.triggers.filter(item => end ? item.at <= end : !before || item.at < before)
    const timeline = kept.slice(-50)
    return { ...threadSummary(), tickets: [], correlated: [], decisions: [], context: [], url: undefined, timeline,
      earlier: kept.length > 50 ? timeline[0]!.at : null }
  }
  return thread
}
/** 时间线展示的触发按编号列出，从旧到新。 */
const shown = () => all('.dt-event .dt-event-text').map(item => Number(item.textContent!.replace('message m', ''))).reverse()
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => from + n)

it('新到的触发多于一页容量时，回读最新页与已显示较早页之间的触发', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  const thread = busyThread(120)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await mount()
  expect(shown()).toEqual(range(70, 119))
  await click(zh.loadEarlier)
  expect(shown()).toEqual(range(20, 119))
  // 新触发少于一页容量时仍会并入较早页；超出则留下缺口，由回读补齐。
  thread.add(10)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(shown()).toEqual(range(20, 129))
  thread.add(60)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(shown()).toEqual(range(20, 189))
  await click(zh.loadEarlier)
  expect(shown()).toEqual(range(0, 189))
})

it('展示久远处的链接目标及其之后的每条触发', async () => {
  busyThread(120)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root', query: { trigger: 'm10' } })
  await mount()
  expect(shown()).toEqual(range(0, 119))
  expect(document.querySelector('.dt-highlight .dt-event-text')?.textContent).toBe('message m10')
  expect(all('button').some(button => button.textContent === zh.loadEarlier)).toBe(false)
})

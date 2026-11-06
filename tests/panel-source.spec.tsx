// @vitest-environment jsdom
// Source 状态与设置。
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf, droppedReply } from './fixtures/panel-server.ts'

usePanel()
it('shows each Source\'s state on the Source status and opens its settings from a setup problem', async () => {
  await mount()
  await click(zh['tab.source'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(all('.dt-form > .dt-list > .dt-row .dt-row-name').map(title => title.textContent)).toEqual(['飞书', 'GitHub'])
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.querySelector('.dt-row-meta')?.textContent).toBe('24 小时到达 12被过滤 2最近 ' + document.querySelector('.dt-row-meta time, .dt-row-meta .dt-lv:last-child .dt-lv-value')?.textContent)
  expect(text()).toContain(zh['sourceState.error'])
  expect(text()).toContain('socket closed')
  expect(all('.dt-card')).toHaveLength(0)
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  await remount()
  await click(zh['tab.source'])
  await click(zh.sourceOpenSettings)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  expect(all('.dt-card')[1]!.textContent).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
})

it('folds more than six chats into a line of their names', async () => {
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['团队群', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join('、'))
})

it('rereads the chats the bot has joined on request and says which are new, keeping unsaved edits', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = () => all('.dt-card')[0]!
  const button = () => [...feishu().querySelectorAll('button')].find(item => item.textContent === '刷新群列表')!
  await click([...feishu().querySelectorAll('button')].find(item => item.textContent === '添加')!)
  server.joining = { oc_new: '新群' }
  await click(button())
  expect(server.requests.find(request => request.path === 'sources/feishu/labels')).toMatchObject({ method: 'POST' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('列表已更新，新增：新群')
  // 正在新增的行保留，并且现在提供新的聊天。
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群', '新群'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.labelsCurrent)
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('读取失败，列表保持不变：lark-cli: token expired')
  expect(button().disabled).toBe(false)
  // 只有键列提供刷新功能的字段才显示该按钮。
  expect([...all('.dt-card')[1]!.querySelectorAll('button')].some(item => item.textContent === '刷新群列表')).toBe(false)
})

it('renders each Source\'s settings from its kind\'s fields and saves one Source against its own revision', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['飞书', 'GitHub'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('接收的群')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '添加')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // 已保存的聊天显示其名称；正在新增的行从尚未配置的已加入聊天中选择。
  expect(rows[0]!.querySelector('.dt-row-label')?.textContent).toBe('团队群')
  expect(rows[0]!.querySelector('select[aria-label="选择机器人已加入的群"]')).toBeNull()
  const pick = rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群'])
  await type(pick, 'oc_other')
  await type(rows[1]!.querySelector('select[aria-label="接收"]')!, 'all')
  await click('接收私聊')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_other', listen: 'all' }],
      directMessages: false } } } })
  expect(server.settings.sources.feishu!.config).toMatchObject({ directMessages: false })
  const github = all('.dt-card')[1]!
  await click('运行来源：GitHub')
  server.revisions['source:github'] = 5
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  // 另一次保存没有改动本草稿改动的内容，因此草稿迁移到更新的修订版本并从那里保存。
  expect(github.querySelector('.dt-savebar')?.textContent).toContain('设置已在别处修改，你的修改已合并到最新版本')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github).toMatchObject({ enabled: false })
  expect(server.revisions['source:github']).toBe(6)
})

it('shows the account each CLI signs in as, and keeps a saved CLI on screen while dsh-superagent restarts', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  const github = all('.dt-card')[1]!
  expect(github.textContent).toContain('当前账号 @agent-bot')
  const labels = () => [...github.querySelectorAll('label')].map(label => label.textContent)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI'])
  expect(field<HTMLInputElement>('监听的仓库').value).toBe('acme/widgets')
  // 事实描述的是已保存的值，因此编辑后的 CLI 在保存前不显示任何事实。
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.textContent).not.toContain('当前账号 @agent-bot')
  await click(zh.discard)
  expect(github.textContent).toContain('当前账号 @agent-bot')
  await click([...github.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes('高级'))!)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI', '轮询间隔 / 秒', '连续失败几次后报告异常'])
  expect(all('.dt-card')[0]!.textContent).toContain('当前机器人 Widgets Bot')
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  expect(github.textContent).toContain('保存会重启 dsh-superagent：2 个进行中的派工会中断，并带恢复说明重新开始。')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ cli: '/opt/bin/gh-agent' })
  expect(text()).toContain(zh.savedRestarting)
  // 已保存的值保留，该 card 的字段被禁用，直到重启后的 dsh-superagent 带回已保存的修订版本。
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  expect(sessionStorage.getItem('dsh-superagent/draft/master/source:github')).toBeNull()
})

it('points a setup problem at the settings that fix it', async () => {
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  // jsdom 没有滚动；用 mock 的 scrollIntoView 记录链接把哪个 card 带入视野。
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(text()).toContain(zh.problemSetup)
  expect(text()).toContain(zh['setup.agentCliUnset'])
  // setup 等待期间不运行任何东西，因此 Executor 会说明这一点而不是进行计数。
  expect(text()).toContain(zh.executorWaitingSetup)
  expect(all('.dt-stat').map(stat => stat.textContent)).not.toContain('执行中2 / 3')
  expect(text()).toContain('在设置 › 来源的 GitHub 卡片修正后保存，会重新检查')
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  expect(all('.dt-card')[1]!.textContent).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  expect(scroll.mock.contexts).toContain(all('.dt-card')[1])
  delete (Element.prototype as Partial<Element>).scrollIntoView
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  // 在 dsh-superagent 之外修复后，检查会再次运行 setup。
  await click(zh.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(zh.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(zh['tab.overview'])
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  expect(text()).toContain('部署检查未通过：git 没有读取 dsh-superagent 为 github.com 写的凭据配置')
})

it('shows a failed Feishu bot check as a problem of the Feishu Source only, with a check after a fix outside dsh-superagent', async () => {
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    accounts: { ...server.setup.accounts!, feishu: null } }
  await mount()
  expect(text()).toContain(zh.problemSetupFeishu)
  expect(text()).not.toContain('飞书 来源异常')
  await click(find(zh.problemSetupFeishu, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('部署检查未通过：应用 cli_bot 的机器人身份状态是 missing；用 lark-cli 配置应用密钥。')
  // 与此同时 dsh-superagent 正在运行，因此再次检查会先询问：重启会中断正在运行的 Executor Session。
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '重新检查')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新检查会重启 dsh-superagent：2 个进行中的派工会中断')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
  await click(tab(zh['tab.source']))
  // Source 的 state 会携带该问题一次，不会在其 health 中重复。
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.textContent?.match(/cli_bot 的机器人身份状态是 missing/g)).toHaveLength(1)
})

it('leaves Feishu out of a GitHub-only deployment', async () => {
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  expect([...field<HTMLSelectElement>(zh.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['主 Session',
    '执行器 Session', 'dsh-superagent-github'])
})

it('shows the Sources waiting for the deployment check, and the problem on the Source that fixes it, with its link', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await mount()
  await click(zh['tab.source'])
  const rows = all('.dt-form > .dt-list > .dt-row')
  // 问题在 GitHub Source 处修复，因此由它显示错误；Feishu 则等待。
  expect(rows.map(row => row.querySelector('.dt-status-text')?.textContent)).toEqual(['等待部署检查', '出错'])
  expect(text()).not.toContain('Waiting for setup')
  expect(rows[1]!.textContent).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  await click(find(zh.sourceOpenSettings, '.dt-row button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
})

it('shows a Source\'s health in the interface language, and a diagnostic as reported', async () => {
  server.health = { github: { state: 'error', detail: '3 consecutive failed polls; last: EOF', code: 'pollFailures', values: { count: '3',
    error: 'EOF' } } }
  await mount()
  await click(zh['tab.source'])
  const github = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === 'GitHub')!
  expect(github.textContent).toContain('GitHub 来源：连续 3 次轮询失败，最近一次：EOF')
  expect(github.textContent).not.toContain('consecutive')
  const feishu = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === '飞书')!
  expect(feishu.querySelector('.dt-mono')?.textContent).toBe('socket closed')
})

it('shows a refused Source save with the output of the tool that failed on its own line', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = all('.dt-card')[0]!
  await type(field<HTMLInputElement>('机器人的 lark-cli'), 'lark-broken')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('机器人的 lark-cli 不可用。\nlark-cli: app secret missing')
})

it('shows a setup problem on its Source card within one read of the settings, which the settings groups share', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-github')!
  expect(card().textContent).not.toContain(zh['setup.agentCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  // settings 与 state 一样每五秒读取一次；Source 设置不读取 Source 状态。
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(zh['setup.agentCliUnset'])
})

it('lists the messages a Source did not send in the last day under it, newest first, with why and where they belong', async () => {
  // 包含一条超过 24 小时的丢弃（m0）和一条缺少 thread 的丢弃（m1）。
  server.dropped = [droppedReply('m3', 1, 'feishu', 'channelGone', { ticket: { id: 't1', title: '修复回归' } }),
    droppedReply('m2', 3, 'feishu', 'channelIgnored'), droppedReply('m1', 4, 'feishu', 'channelGone', { thread: false }),
    droppedReply('m0', 30, 'feishu', 'channelGone'), droppedReply('g0', 2, 'github', 'channelGone')]
  await mount()
  await click(zh['tab.source'])
  const [feishu, github] = all('.dt-form > .dt-list > .dt-row')
  const disclosure = (scope: Element) =>
    [...scope.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes(zh.sourceDroppedTitle))!
  await click(disclosure(feishu!))
  const rows = [...feishu!.querySelectorAll('.dt-disclosure-body .dt-row')].map(row => [row.querySelector('.dt-row-title')?.textContent,
    row.querySelector('.dt-tag')?.textContent, row.querySelector('button')?.textContent])
  expect(rows).toEqual([['Reply m3', zh['reason.channelGone'], '修复回归'],
    ['Reply m2', zh['reason.channelIgnored'], zh['term.thread']], ['Reply m1', zh['reason.channelGone'], undefined]])
  expect(github!.textContent).toContain(`${zh.sourceDroppedTitle} 1`)
  await click(find('修复回归', '.dt-disclosure-body button'))
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await remount()
  await click(zh['tab.source'])
  await click(disclosure(document.body))
  // Feishu Channel 指明其聊天；该链接打开它所回复消息的 Thread，该 Thread 由宿主找到。
  await click(find(zh['term.thread'], '.dt-disclosure-body button'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(text()).not.toContain(zh.threadNotFound)
})

it('takes no space for messages that were all sent', async () => {
  await mount()
  await click(zh['tab.source'])
  expect(text()).not.toContain(zh.sourceDroppedTitle)
})

it('reads the settings again as soon as dsh-superagent answers after a save restarted it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  const github = all('.dt-card')[1]!
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  // dsh-superagent 重启：DSH 先返回空的 404，之后它再次响应。
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(false)
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
})

// @vitest-environment jsdom
// 来源页状态与设置。
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf, droppedReply } from './fixtures/panel-server.ts'

usePanel()
it('在来源状态页展示各来源的状态，并从部署问题打开其设置', async () => {
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

it('把超过六个的群折叠为一行名称', async () => {
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['团队群', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join('、'))
})

it('按需重读机器人已加入的群并说明哪些是新增，同时保留未保存的编辑', async () => {
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
  // 正在添加的行保持不变，现在可以选到新群。
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群', '新群'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.labelsCurrent)
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('读取失败，列表保持不变：lark-cli: token expired')
  expect(button().disabled).toBe(false)
  // 只有键列支持刷新的字段才显示刷新按钮。
  expect([...all('.dt-card')[1]!.querySelectorAll('button')].some(item => item.textContent === '刷新群列表')).toBe(false)
})

it('按各来源 kind 的字段渲染其设置，并针对各自的版本号保存单个来源', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['飞书', 'GitHub'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('接收的群')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '添加')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // 已保存的群显示其名称；新增中的行从尚未配置的已加入群中挑选。
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
  // 另一次保存没有改动本草稿涉及的内容，因此草稿重放到更新的版本号上并从那里保存。
  expect(github.querySelector('.dt-savebar')?.textContent).toContain('设置已在别处修改，你的修改已合并到最新版本')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github).toMatchObject({ enabled: false })
  expect(server.revisions['source:github']).toBe(6)
})

it('显示各 CLI 登录的账号，并在 dsh-superagent-cn 重启期间保持已保存的 CLI 在屏幕上', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  const github = all('.dt-card')[1]!
  expect(github.textContent).toContain('当前账号 @agent-bot')
  const labels = () => [...github.querySelectorAll('label')].map(label => label.textContent)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI'])
  expect(field<HTMLInputElement>('监听的仓库').value).toBe('acme/widgets')
  // 说明文字描述的是已保存的值，因此编辑中的 CLI 在保存前不显示。
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.textContent).not.toContain('当前账号 @agent-bot')
  await click(zh.discard)
  expect(github.textContent).toContain('当前账号 @agent-bot')
  await click([...github.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes('高级'))!)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI', '轮询间隔 / 秒', '连续失败几次后报告异常'])
  expect(all('.dt-card')[0]!.textContent).toContain('当前机器人 Widgets Bot')
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  expect(github.textContent).toContain('保存会重启 dsh-superagent-cn：2 个进行中的派工会中断，并带恢复说明重新开始。')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ cli: '/opt/bin/gh-agent' })
  expect(text()).toContain(zh.savedRestarting)
  // 已保存的值保持不变，卡片的字段被禁用，直到重启后的 dsh-superagent-cn 带回已保存的版本。
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  expect(sessionStorage.getItem('dsh-superagent-cn/draft/master/source:github')).toBeNull()
})

it('把部署问题指向能修复它的设置', async () => {
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  // jsdom 不支持滚动；mock scrollIntoView 以记录链接把哪张卡片带入视口。
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(text()).toContain(zh.problemSetup)
  expect(text()).toContain(zh['setup.agentCliUnset'])
  // 部署检查未通过时什么都不运行，因此执行器直接说明这一点而不是给计数。
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
  // 在 dsh-superagent-cn 之外修复后，检查按钮会重新运行部署检查。
  await click(zh.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(zh.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(zh['tab.overview'])
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  expect(text()).toContain('部署检查未通过：git 没有读取 dsh-superagent-cn 为 github.com 写的凭据配置')
})

it('把失败的飞书机器人检查只显示为飞书来源的问题，在 dsh-superagent-cn 之外修复后可重新检查', async () => {
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    accounts: { ...server.setup.accounts!, feishu: null } }
  await mount()
  expect(text()).toContain(zh.problemSetupFeishu)
  expect(text()).not.toContain('飞书 来源异常')
  await click(find(zh.problemSetupFeishu, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('部署检查未通过：应用 cli_bot 的机器人身份状态是 missing；用 lark-cli 配置应用密钥。')
  // dsh-superagent-cn 此刻正在运行，因此重新检查会先询问：重启会中断运行中的执行器 Session。
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '重新检查')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新检查会重启 dsh-superagent-cn：2 个进行中的派工会中断')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
  await click(tab(zh['tab.source']))
  // 来源的状态只携带一次该问题，不会再作为其健康详情重复出现。
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.textContent?.match(/cli_bot 的机器人身份状态是 missing/g)).toHaveLength(1)
})

it('仅部署 GitHub 时不含飞书', async () => {
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  expect([...field<HTMLSelectElement>(zh.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['主 Session',
    '执行器 Session', 'dsh-superagent-cn-github'])
})

it('展示等待部署检查的来源，并在能修复该问题的来源上显示问题及其链接', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await mount()
  await click(zh['tab.source'])
  const rows = all('.dt-form > .dt-list > .dt-row')
  // GitHub 来源是修复该问题之处，因此由它显示错误；飞书则等待。
  expect(rows.map(row => row.querySelector('.dt-status-text')?.textContent)).toEqual(['等待部署检查', '出错'])
  expect(text()).not.toContain('Waiting for setup')
  expect(rows[1]!.textContent).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  await click(find(zh.sourceOpenSettings, '.dt-row button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
})

it('以界面语言显示来源健康状态，诊断信息按原样显示', async () => {
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

it('来源保存被拒时，把失败工具的输出逐行显示', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = all('.dt-card')[0]!
  await type(field<HTMLInputElement>('机器人的 lark-cli'), 'lark-broken')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('机器人的 lark-cli 不可用。\nlark-cli: app secret missing')
})

it('在一次设置读取之内把部署问题显示到其来源卡片上，各设置分组共享这次读取', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-github')!
  expect(card().textContent).not.toContain(zh['setup.agentCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  // 设置与状态一样每五秒读取一次；来源设置不读取来源状态。
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(zh['setup.agentCliUnset'])
})

it('在来源下方列出其过去一天未发出的消息，从新到旧，并说明原因与所属位置', async () => {
  // 包含一条超过 24 小时的丢弃（m0）和一条缺少线程的丢弃（m1）。
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
  // 飞书渠道会显示其群名称；链接打开它所回复消息的线程（宿主已找到该线程）。
  await click(find(zh['term.thread'], '.dt-disclosure-body button'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(text()).not.toContain(zh.threadNotFound)
})

it('全部消息都已发送时不占空间', async () => {
  await mount()
  await click(zh['tab.source'])
  expect(text()).not.toContain(zh.sourceDroppedTitle)
})

it('保存触发重启后，dsh-superagent-cn 一恢复响应就重新读取设置', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  const github = all('.dt-card')[1]!
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  // dsh-superagent-cn 重启：DSH 先以空 404 应答，随后它恢复响应。
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(false)
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
})

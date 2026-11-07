// @vitest-environment jsdom
// 提示词设置。
import { act } from 'react'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, promptVersion } from './fixtures/panel-server.ts'

usePanel()
it('列出团队小节与内置部件，编辑并保存它们（与设置分开），并可重置单个小节', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  const names = all('.dt-prompt-nav .dt-nav-item > span').map(item => item.textContent)
  expect(names.slice(0, 3)).toEqual(['沟通方式', '工单范围', '交付要求'])
  expect(names.slice(3)).toEqual(Object.keys(builtInParts()).map(key => zh[`promptPart.${key}` as keyof typeof zh]))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Custom communication rule')
  expect(text()).toContain('1 处修改')
  await click(tab(zh.promptViewFull))
  // 完整 prompt 按主 Session 读取的顺序展示每个部件（团队或内置），均可编辑。
  const parts = all('.dt-preview-part').map(part => [part.querySelector('b')?.textContent, part.hasAttribute('data-editable')])
  expect(parts.slice(0, 5)).toEqual([['共享约定', true], ['主 Session 角色', true], ['沟通方式', true], ['工单范围', true], ['交付要求', true]])
  expect(text()).toContain('Custom communication rule')
  await click(all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === '沟通方式')!.querySelector('button')!)
  await click(zh.promptResetSection)
  expect(text()).not.toContain('处修改')
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Second rule')
  await click(zh.save)
  expect(server.prompts.current.config.communication).toBe('Second rule')
  expect(server.requests.some(request => request.path.startsWith('settings/'))).toBe(false)
})

it('保留冲突的提示词草稿，将其重放到较新版本上，重试时保存成功', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), scope: 'Theirs' })
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).toContain('提示词已被修改到版本 1。已保留你的草稿')
  await click(zh.save)
  // 另一次保存的小节保持不变：草稿是逐小节重放到版本 1 上的，而非整体覆盖。
  expect(server.prompts.current.config).toMatchObject({ communication: 'Mine', scope: 'Theirs' })
})

it('在完整 prompt 中展示内置 skill 及 CLI 说明，可按内置部件编辑；可添加团队 skill，但不能以内置名添加', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  await act(async () => { const select = field<HTMLSelectElement>(zh.promptPreviewTarget); select.value = 'skill/github'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  expect(text()).toContain('## CLI 用法')
  expect(all('.dt-preview-part[data-editable] b').map(name => name.textContent)).toEqual([zh['promptPart.skill/github']])
  await click(tab(zh.promptViewEdit))
  for (const name of ['Bad Name', 'github']) {
    await type(field<HTMLInputElement>(zh.promptAddSkill), name)
    await click(zh.promptAddSkillAction)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.promptSkillNameInvalid)
  }
  await type(field<HTMLInputElement>(zh.promptAddSkill), 'testing')
  await click(zh.promptAddSkillAction)
  expect(all('.dt-nav-item').map(item => item.textContent)).toContain('dsh-superagent-cn-testing')
})

it('从历史把全部默认内容载入草稿，而不立即保存', async () => {
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), scope: 'Old scope' })
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewHistory))
  const first = `版本 0 · ${zh.promptHistoryInitial} · ${zh['historySource.defaults']}`
  expect(all('.dt-row-title').map(title => title.textContent)).toContain(first)
  await click(zh.promptDefaults)
  expect(text()).toContain(zh.promptDraftFromDefaults)
  expect(server.requests.some(request => request.path === 'prompts' && request.method === 'PUT')).toBe(false)
})

it('未改动的草稿加载预览期间不显示提示词保存栏', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  let shown = false
  const watch = new MutationObserver(() => { if (document.querySelector('.dt-savebar')) shown = true })
  watch.observe(document.body, { childList: true, subtree: true })
  await click(tab(zh.promptViewFull))
  await settle()
  watch.disconnect()
  expect(shown).toBe(false)
})

it('标出与默认内容不同的团队小节，草稿以相对已保存版本或默认内容的 diff 形式展示', async () => {
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), delivery: `${defaultPrompts().delivery}\nCommit as the bot account.` })
  server.prompts.revision = 1
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-nav-item').filter(item => item.querySelector('.dt-changed-tag')).map(item => item.querySelector('span')!.firstChild?.textContent)).toEqual(['交付要求'])
  await type(field<HTMLTextAreaElement>(zh.promptBody), `${defaultPrompts().communication}\nSign as the agent.`)
  await click(tab(zh.promptViewFull))
  // 草稿相对已保存版本打开：只显示其改动，未改动的部件折叠。
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n'])
  expect(all('.dt-preview-part del')).toHaveLength(0)
  expect(text()).toContain(zh.promptSameAsSaved)
  await click(zh.promptCompareDefault)
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n', 'Commit as the bot account.\n'])
})

it('通过重新读取已保存版本来丢弃提示词草稿', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), communication: 'Theirs' })
  await click(zh.discard)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('Theirs')
  expect(all('.dt-savebar')).toHaveLength(0)
})

const builtInItem = (name: string) => all('.dt-prompt-nav .dt-nav-item').find(item => item.querySelector('span')!.firstChild?.textContent === name)!
it('把内置部件编辑为对其内置文本的覆盖，标记为已修改，并可重置回内置文本', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  const shared = builtInParts()['runtime/shared']!
  await click(builtInItem(zh['promptPart.runtime/shared']))
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  expect(text()).toContain(zh['promptReadBy.both'])
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, the team way.')
  expect(builtInItem(zh['promptPart.runtime/shared']).querySelector('.dt-changed-tag')?.textContent).toBe(zh.promptChanged)
  await click(zh.save)
  // 覆盖会记录其编辑时依据的内置文本。
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/shared': { text: 'Shared, the team way.', base: builtInBase(shared.text) } })
  // 完整 prompt 在与默认内容对比时读取覆盖文本以替代内置文本。
  await click(tab(zh.promptViewFull))
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toContain('Shared, the team way.\n')
  await click(all('.dt-preview-part[data-editable] button')[0]!)
  await click(zh.promptResetSection)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  await click(zh.save)
  expect(server.prompts.current.config).not.toHaveProperty('overrides')
})

it('说明模板必须保留哪些占位符', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/policy']))
  expect(text()).toContain('这是模板：保留占位符 {version}、{mode}、{rules}，由系统填入内容。')
  expect(text()).toContain(zh['promptReadBy.orchestrator'])
})

it('标出内置文本被升级改动的覆盖，展示其变化，并保留团队文本或采用新文本', async () => {
  const dispatch = builtInParts()['runtime/dispatch']!
  const overrides = { 'runtime/dispatch': { text: '## 派工\nOur routing.', base: builtInBase('## 派工\nThe old routing.') } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: overrides['runtime/dispatch'].base, previous: '## 派工\nThe old routing.' }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-updated-tag').map(tag => tag.closest('.dt-nav-item')!.querySelector('span')!.firstChild?.textContent))
    .toEqual([zh['promptPart.runtime/dispatch']])
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // 在标记命名的区域内展示内置文本的变化，旁边是保持不变的团队文本。
  const box = () => document.querySelector(`section[aria-label="${zh.promptDefaultUpdated}"]`)
  expect(box()!.textContent).toContain('下面是默认内容的变化。')
  expect([...box()!.querySelectorAll('del')].map(line => line.textContent)).toEqual(['The old routing.\n'])
  expect(box()!.querySelectorAll('ins').length).toBeGreaterThan(0)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('## 派工\nOur routing.')
  // 采用新内置文本即丢弃覆盖。
  await click(zh.promptTakeDefault)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(dispatch.text)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(zh.discard)
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // 保留团队文本会记录新内置文本为其编辑依据。
  await click(zh.promptKeepMine)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': { text: '## 派工\nOur routing.', base: builtInBase(dispatch.text) } })
})

it('编辑依据的默认内容未知或不同时，将团队文本与新默认内容对比展示', async () => {
  const dispatch = builtInParts()['runtime/dispatch']!
  // 覆盖是从更早的版本恢复的：其 base 不是检测到默认内容变化时的那一个。
  const overrides = { 'runtime/dispatch': { text: '## 派工\nOur routing.', base: 'restored' } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: 'another', previous: '## 派工\nThe old routing.' }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  const box = document.querySelector(`section[aria-label="${zh.promptDefaultUpdated}"]`)!
  // 提示文案说明这些行是团队文本与新默认内容的对比，而不是默认内容的变化。
  expect(box.textContent).toContain('系统没有记录你编辑时的默认内容；下面是你的文本与新默认内容的对比。')
  expect(box.textContent).not.toContain('下面是默认内容的变化。')
  expect([...box.querySelectorAll('del')].map(line => line.textContent)).toEqual(['Our routing.\n'])
  expect([...box.querySelectorAll('ins')].map(line => line.textContent).join('')).toBe(`${dispatch.text.split('\n').slice(1).join('\n')}\n`)
})

it('草稿重放到期间保存的版本上时，保留双方各自的覆盖', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/shared']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, ours.')
  const theirs = { 'runtime/dispatch': { text: '## 派工\nTheirs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides: theirs })
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).not.toContain('undefined')
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ ...theirs,
    'runtime/shared': { text: 'Shared, ours.', base: builtInBase(builtInParts()['runtime/shared'].text) } })
})

it('展示草稿中生成类部件的模板填充效果，保存被拒时按标签指出问题部件', async () => {
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/environment']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Where you work:\n{variables}')
  await click(tab(zh.promptViewFull))
  const environment = all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === zh['promptPart.runtime/environment'])!
  expect(environment.querySelector('pre')?.textContent).toBe('Where you work:\n')
  await click(tab(zh.promptViewEdit))
  await click(builtInItem(zh['promptPart.runtime/policy']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), '## Policy\n{version} {mode}')
  await click(zh.save)
  expect(text()).toContain(`「${zh['promptPart.runtime/policy']}」的模板必须保留占位符 {rules}`)
})

it('列出版本中已不存在的部件的覆盖，下次保存将丢弃它们', async () => {
  server.prompts.defaultChanged = [{ part: 'runtime/retired', base: 'b', removed: true }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(text()).toContain(zh.promptRemovedParts.replace('{parts}', 'runtime/retired'))
})

it('从历史载入版本时剔除其中对本版本已不存在部件的覆盖，使其可以保存', async () => {
  const dispatch = { text: '## 派工\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewHistory))
  // 恢复的版本覆盖了一个后续版本已移除的部件。
  const saved = server.prompts.current
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch, 'runtime/retired': { text: 'Old.', base: 'b' } } })
  await click(zh.promptRestore)
  server.prompts.current = saved
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': dispatch })
})

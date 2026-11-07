// @vitest-environment jsdom
/** Settings 标签页的部署视图：只读展示配置文件决定的限制与派生的部署状态。 */
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf } from './fixtures/panel-server.ts'

usePanel()

it('shows this machine\'s limits read-only, with no save bar', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain(zh.deploymentIntro)
  expect(text()).toContain('/srv/dsh-superagent')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(field<HTMLInputElement>(zh.deploymentContextPages)).toMatchObject({ disabled: true, value: '10' })
  // 限制值来自启动时读取的配置文件，因此没有草稿、保存或丢弃。
  expect(text()).not.toContain(zh.save)
  expect(document.querySelector('.dt-savebar')).toBeNull()
  // 输入控件是禁用的：键入不改变任何值。
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('15000')
})

it('explains a failed setup check and offers to check again', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain(zh['setup.repositoryUnset'])
  expect(all('button').some(button => button.textContent === zh.setupCheck)).toBe(true)
  // 部署视图不再展示仓库与账号：它们在 Source 设置与概览中。
  expect(text()).not.toContain('acme/widgets')
  expect(text()).not.toContain('@agent-bot')
  server.setup = { ...server.setup, problem: null }
  await remount()
  expect(text()).not.toContain(zh['setup.repositoryUnset'])
})

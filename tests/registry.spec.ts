import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { feishuChannel, feishuTrigger, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('来源注册表', () => {
  it('按 id 顺序列出每个已安装 kind 及其默认值，末尾是 kind 未安装的已存储实例', () => {
    const settings = SettingsSchema.parse({ sources: { probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(probe); sources.register(githubKind)
    expect(sources.instances()).toEqual([
      { id: 'github', kind: 'github', enabled: true, config: { repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
        observeIssues: false, observePulls: false, observeComments: false, observeCi: false }, installed: true },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
  })
  it('用 kind 的 schema 校验提交的实例，并拒绝未安装的 kind', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
  })
  it('通过 kind 自己的渠道与上下文发送、链接和读取其线程，没有这些能力的 kind 则什么都不做', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }))
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({ ...probe,
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' },
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }) },
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (_commands, trigger, part, cursor, config) => {
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }],
          body: { page: cursor ?? 'first' } }
      } } })
    const commands = {} as Commands
    const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi', kind: 'reply' })
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    expect(sent).toEqual([message('probe')])
    // 未安装的 kind 让其回复继续等待；指向它的链接没有页面。
    expect(await sources.send(message('retired'), commands)).toBe('waiting')
    expect(sources.link(message('probe').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    expect(sources.link(message('retired').channel, {})).toEqual({ url: '', label: { zh: 'retired', en: 'retired' } })
    const trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    expect(context.images('img_x')).toEqual([])
    await expect(context.image({} as Agent, commands, { id: 'm1', text: '' }, 'img_x', '',
      new AbortController().signal)).rejects.toThrow('no images')
    // 没有渠道或上下文的 kind 两者皆无。
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('拒绝声明了其他 kind 或 dsh-superagent-cn 自身健康条目的 kind，注销时放弃其条目', () => {
    const board = new HealthBoard()
    // 预先占用内置健康条目；sync:* 条目保留给设置同步。
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const unregister = sources.register(githubKind)
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow('declares the health entry github')
    for (const name of ['runtime', 'reply', 'sync:github']) expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    expect(sources.kind('probe')).toBeUndefined()
    sources.register({ ...probe, health: ['probe'] })
    const context = (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ sources } as unknown as SourceContextDeps, kind)
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // kind 注销后发来的报告（例如来自正在退出的 CLI 监听器）会被忽略，不影响之后的注册。
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
  })
  it('在 kind 支持时指出某条触发的消息所回复的触发', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    const reply = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
      content: 'yes', create_time: '1757376000000', parent_id: 'om_1' }, 'ou_bot', 'cli_bot')!
    expect(sources.repliesTo(reply)).toBe(feishuTriggerId('om_1'))
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
  })
  it('按各 kind 的表达方式找到搜索查询所指的对象', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({ threads: ['github:7'], terms: [] })
    expect(sources.find('see om_abc and om_abc, om_def')).toEqual({ threads: [], terms: ['om_abc', 'om_def'] })
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    expect(feishuKind.policy!.unnamed).toEqual({ person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } })
  })
  it('拒绝同一 kind 的重复注册，并在其清理函数运行后忘记该 kind', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it('用各来源的 kind 校验策略中的来源部分，未安装 kind 的部分按存储原样保留', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } }))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.validatePolicy({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: '', admission: {} }, retired: { allowed: [], x: 1 } })
    expect(() => sources.validatePolicy({ feishu: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('feishu')).toEqual({ allowed: [{ id: 'ou_alice' }], syncChat: '', admission: {} })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
  })
  it('只允许在其来源仍监听对应群的渠道上回复', () => {
    const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false } } } })
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(false)
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_other' } })).toBe(false)
    // 私聊群的 id 同样以 oc_ 开头；地址标记了它是私聊，私聊关闭时不予回复。
    expect(sources.channelAllowed(feishuChannel('oc_dm', 'om_1', true))).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
  })
  it('在默认设置下把回复投递到私聊', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind)
    const trigger = feishuTrigger({ message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: 'ou_alice', sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    const channel = trigger.channel!
    expect(channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_dm', direct: 'true' })
    expect(sources.channelAllowed(channel)).toBe(true)
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"data":{}}')
    const reply: OutboundMessage = { id: 'reply-1', channel, text: 'Done', kind: 'reply' }
    expect(await sources.send(reply, commands)).toBe('sent')
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['+messages-reply', '--message-id', 'om_dm']))
  })
})

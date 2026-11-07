import { describe, expect, it } from 'vitest'
import { SettingsSchema, assessmentOutcome, policyEffects, settingsPolicy, policyVersion, allowedSender, anyoneAllowed, type Settings } from '../src/policy.ts'
import type { MandateBasis } from '../src/core/index.ts'
import { migrateSettings } from '../src/app/migration.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'
const feishuSource = (config: { chats: { chatId: string; listen: 'mentions' | 'all' }[]; directMessages: boolean }, enabled = true) => ({ enabled, config })
const base = SettingsSchema.parse({
  policy: { sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'Alice' }] } } },
  eval: { mode: 'auto' },
  sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: true }) },
})
function setup(settings: Settings = base) {
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind); sources.register(githubKind)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}
const { sources, policy } = setup()
const thread = (subscriptions: string[] = []): Thread => ({ key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: '', subscriptions, correlated: [], pending: [], meta: {} })
const feishu = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({ id: 't', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '', text: 'hi', addressed: 'mention', meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })
const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => { const { addressed: _addressed, ...rest } = feishu(overrides); return rest }
const github = (login: string, addressed?: 'mention'): Trigger => ({ id: 'g', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: login }, human: true, at: '', text: 'x', ...addressed ? { addressed } : {}, meta: { number: 1, isPr: true } })
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket

describe('来源范围', () => {
  it('监听配置的群，仅在配置处读取每条消息，并遵循私聊开关', () => {
    expect(sources.scope(feishu())).toEqual({ listened: true, observed: false, row: CHAT })
    expect(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } }))).toEqual({ listened: true, observed: true, row: OBSERVED })
    expect(sources.scope(feishu({ meta: { chatId: 'oc_other', direct: false, mentioned: true } }))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(sources.scope(github('anyone'))).toEqual({ listened: true, observed: false })
  })
  it('插件未加载的已配置来源不监听任何内容，且无效的存储配置保持停用', () => {
    const bare = new SourceRegistry(() => base)
    expect(bare.scope(feishu())).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(bare.scope(github('anyone'))).toEqual({ listened: true, observed: false })
    const broken = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: 'oops' } } } }))
    broken.register(feishuKind)
    expect(broken.instance('feishu')).toMatchObject({ enabled: false })
    expect(broken.scope(feishu())).toEqual({ listened: false, reason: 'source_disabled' })
  })
  it('过滤掉停用来源的一切消息', () => {
    expect(setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(github('anyone'))).toEqual({ listened: false, reason: 'source_disabled' })
  })
})
describe('准入', () => {
  it('发送者在其来源部分获准且来源标记触发已点名时，授予 explicit 强度', () => {
    expect(policy.gate(feishu(), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } } })
    expect(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
    // GitHub 登录名比较不区分大小写；条目没有显示名时以 id 指名发送者。
    expect(policy.gate(github('alice', 'mention'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { source: 'github', sender: 'Alice' } })
  })
  it('检查各来源自己的名单：飞书 id 在 GitHub 上不允许任何东西', () => {
    expect(policy.gate(github(MEMBER, 'mention'), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(allowedSender(base, { source: 'github', id: 'ALICE' })).toEqual({ id: 'Alice' })
    expect(allowedSender(base, { source: 'feishu', id: 'Alice' })).toBeUndefined()
    expect(anyoneAllowed(base)).toBe(true)
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
  })
  it('研判有工单线程上的后续消息：获准发送者为 explicit，其他人为 inferred', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    expect(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
    expect(policy.gate(github('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
    // 工单仅作上下文跟随的线程不借出后续消息：由接单表决定，与其他线程相同。
    const context = { ...thread(['ticket']), context: ['ticket'] }
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
  })
  it('对来源观察到获准发送者的消息推断强度，评估关闭时除外', () => {
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(policy.gate(observed, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', observation: { mode: 'auto' } } })
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('不接受来源名单之外发送者的私聊消息，即使是后续消息也不行', () => {
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(['ticket']), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('拒绝自动消息、没有线程的陌生发送者，以及未点名智能体的获准发送者', () => {
    expect(policy.gate(feishu({ human: false }), thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
})
describe('接单表', () => {
  const STRANGER = 'ou_stranger'
  const withTable = (admission: Record<string, Record<string, string>>, config: Record<string, unknown> = {}, mode: 'off' | 'observe' | 'auto' = 'auto') => SettingsSchema.parse({ ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu!.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, admission } } } })
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  it('所有单元格未设置时复现接单表之前的行为', () => {
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    // 点名智能体的名单内发送者无论接单表如何设置都构成明确的请求。
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })
  it('按行设置把名单外发送者的点名定为 explicit 或 inferred，inferred 需等待可研判的模式', () => {
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    expect(explicit).toEqual({ admissible: true, strength: 'explicit', basis: { source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: true }, row: CHAT, via: 'admission', cell: 'unlistedAddressed', addressed: 'mention' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off')).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('按行设置忽略名单内发送者未点名的消息，群未接收的消息不读接单表', () => {
    expect(setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'admission_ignored' })
    // 仅 @ 的群不接收未点名的消息，因此即使是 inferred 单元格也不放行。
    expect(setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
    expect(setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER, false), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('仅当飞书卡片设置时，才按 other 行监听未列出群中的点名', () => {
    expect(sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    const others = setup(withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' }))
    expect(others.sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: true, observed: false, row: 'other' })
    expect(others.policy.gate(inChat('oc_elsewhere'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other' } })
    expect(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other', cell: 'unlistedAddressed' } })
  })
  it('评估关闭时不接受 inferred 后续消息，与其他 inferred 候选一样，名单内发送者的除外', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
    expect(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  it('单元格为 explicit 时把名单外发送者的消息定为明确的请求，包括在有工单的线程上，任何模式下皆然', () => {
    for (const mode of ['auto', 'observe', 'off'] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode))
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit',
        basis: { via: 'admission', cell: 'unlistedAddressed' } })
      // 非 explicit 的单元格让后续消息保持 inferred，前提是评估开启。
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode))
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(mode === 'off'
        ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    }
  })
  it('有工单线程上的后续消息不受接单表约束', () => {
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  })
  it('单元格给出的强度低于授权接受时的强度即失效，单元格维持时授权保留', () => {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    if (!gate.admissible) throw new Error('expected admission')
    const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
    expect(setup(open).policy.revalidate(mandate)).toBe(true)
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate)).toBe(false)
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false)
  })
  it('单元格变化时策略版本随之变化', () => {
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version).not.toBe(setup().version)
    expect(setup(withTable({})).version).toBe(setup().version)
  })
})
describe('从接单表重新校验授权', () => {
  type Cell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  const cells: Cell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
  const SENDER = 'ou_sender'
  const origins: { cell: Cell; strength: 'explicit' | 'inferred' }[] = [
    { cell: 'listedUnaddressed', strength: 'inferred' }, { cell: 'unlistedAddressed', strength: 'explicit' },
    { cell: 'unlistedAddressed', strength: 'inferred' }, { cell: 'unlistedUnaddressed', strength: 'inferred' },
  ]
  const cases = origins.flatMap(origin => [true, false].flatMap(listed => (['off', 'observe', 'auto'] as const).flatMap(mode => [true, false].flatMap(rule =>
    (['all', 'mentions', 'none'] as const).flatMap(scope => [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })))))))
  /** docs/002：线程必须仍被接收；点名智能体的名单内发送者为 explicit；此后进入名单的发送者适用名单内单元格。 */
  function expected({ cell, strength, listed, mode, rule, scope, holds }: typeof cases[number]): boolean {
    if (scope === 'none') return false
    if (cell === 'unlistedAddressed' && listed) return true
    const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    return strength === 'explicit' || (mode === 'auto' && rule)
  }
  it.each(cases)('$cell ($strength)，现列入名单 $listed，模式 $mode，规则开关 $rule，群接收 $scope，单元格维持 $holds', item => {
    // 行给每个单元格授予授权接受时的强度；单元格不再维持时为 ignore。
    const grant = (cell: Cell) => !item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred'
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: { feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) } } },
      },
    })
    const addressed = item.cell === 'unlistedAddressed'
    const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' as const }, rules: ['copy'] } : {}
    const basis: MandateBasis = { via: 'admission', source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: addressed }, row: CHAT, cell: item.cell,
      ...addressed ? { addressed: 'mention' as const } : {}, ...observed }
    const mandate = { strength: item.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    expect(setup(settings).policy.revalidate(mandate)).toBe(expected(item))
  })
})
describe('重新校验与版本', () => {
  it('发送者仍在名单且来源仍监听时保留 explicit 授权；规则授权仅在 auto 模式且规则启用时保留', () => {
    const basis: MandateBasis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
    const mandate = { strength: 'explicit' as const, policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
    expect(policy.revalidate(mandate)).toBe(true)
    const nobody = { ...base, policy: { ...base.policy, sources: {} } }
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
    const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
    expect(setup(silent).policy.revalidate(mandate)).toBe(false)
    // 准入尚未记录如何放行触发之前的授权，在其发送者列入名单且来源监听期间有效。
    const listed: MandateBasis = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
    expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false)
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
    const inferred = { ...mandate, strength: 'inferred' as const, basis: { via: 'listed', observation: {}, rules: ['copy'] } satisfies MandateBasis }
    expect(policy.revalidate(inferred)).toBe(true)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred)).toBe(false)
    expect(setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred)).toBe(false)
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
  })
  it('规则、接单模式与各来源部分会改变策略版本；暂停、并发、模型与来源配置则不会', () => {
    const version = setup().version
    expect(setup({ ...base, paused: true, executor: { ...base.executor, maxWorkers: 9 }, eval: { ...base.eval, timeoutSeconds: 300 }, sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } } }).version).toBe(version)
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(version)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version).not.toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version).not.toBe(version)
  })
})
describe('设置迁移', () => {
  it('把每个成员的身份移入策略的各来源部分，并丢弃 prompt 与执行环境已取代的字段', () => {
    const saved = SettingsSchema.parse(migrateSettings({
      policy: { members: [{ name: 'Alice', feishuId: MEMBER, github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }, { name: 'Carol', feishuId: '', github: 'carol' }], memberChat: CHAT, autoMergeLineLimit: 300,
        rules: [{ id: 'visual', name: 'V', enabled: true, visual: true, instruction: 'x' }] },
      executor: { maxWorkers: 2, reviewer: 'dave', visualReviewer: 'carol', branchPrefix: 'bot/' },
      sources: { feishu: { enabled: true, config: { chats: [], directMessages: true }, authority: { chats: [] } } },
    }))
    expect(saved.policy).toEqual({
      rules: [{ id: 'visual', name: 'V', enabled: true, instruction: 'x' }],
      sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: CHAT, admission: {} }, github: { allowed: [{ id: 'alice' }, { id: 'carol' }], admission: {} } },
    })
    expect(saved).toMatchObject({ paused: false, executor: { model: null, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [] } })
    expect(saved.sources.feishu).toEqual({ enabled: true, config: { chats: [], directMessages: true } })
    expect(SettingsSchema.parse(migrateSettings(saved))).toEqual(saved)
    expect(SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, paused: true } }))).toMatchObject({ paused: true, executor: { maxWorkers: 2 } })
  })
  it('把领域化之前的群列表移入飞书来源，暂停移入独立的设置，成员移入各来源部分', () => {
    const migrated = SettingsSchema.parse(migrateSettings({ paused: true, allowedChats: [CHAT, OBSERVED], allowDirectMessages: false, pollSeconds: 120, maxWorkers: 5, members: [{ name: 'A', feishuId: MEMBER, github: 'a' }],
      models: { orchestrator: { provider: 'p', model: 'm' }, worker: null, admission: null }, admission: { mode: 'auto', chats: [OBSERVED], maxEvaluators: 1, timeoutSeconds: 90, rules: [] } }))
    expect(migrated).toEqual({
      paused: true,
      sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: false }), github: { enabled: true, config: { pollSeconds: 120 } } },
      policy: { rules: [], sources: { feishu: { allowed: [{ id: MEMBER, name: 'A' }], admission: {} }, github: { allowed: [{ id: 'a' }], admission: {} } } },
      eval: { mode: 'auto', timeoutSeconds: 90, model: { provider: 'p', model: 'm' } },
      executor: { model: null, maxWorkers: 5, directory: '', prepare: '', blockedCommands: [] },
    })
    expect(migrateSettings(migrated)).toEqual(migrated)
  })
  it('接单关闭期间仅观察的群不进入飞书来源', () => {
    const migrated = SettingsSchema.parse(migrateSettings({ allowedChats: [CHAT], members: [], admission: { mode: 'off', chats: [OBSERVED] } }))
    expect(migrated.sources.feishu!.config).toEqual({ chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true })
  })
})

it('把存储的 prepare 命令读取的变量从早期项目名重命名为当前项目名', () => {
  const settings = SettingsSchema.parse(migrateSettings({ executor: { prepare: 'git worktree add "$DSH_TAG_DIR" -b "agent/${DSH_GO_NAME}" "refs/x/$DSH_FREELANCER_TICKET"' } }))
  expect(settings.executor.prepare).toBe('git worktree add "$DSH_SUPERAGENT_DIR" -b "agent/${DSH_SUPERAGENT_NAME}" "refs/x/$DSH_SUPERAGENT_TICKET"')
})

it('读取不带合并账号的已存 GitHub 来源配置', () => {
  const settings = SettingsSchema.parse(migrateSettings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent', mergeCli: 'gh-merge-account', pollSeconds: 120 } } } }))
  expect(settings.sources.github!.config).toEqual({ repository: 'acme/widgets', cli: 'gh-agent', pollSeconds: 120 })
})

describe('研判结果', () => {
  const settings = (mode: 'auto' | 'observe') => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({ decision: 'accept' as const, rule_assessments: judged(current, matched),
    direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy' })
  it('仅在 auto 模式下按命中的规则接受 inferred 候选，策略只放行启用的命中规则', () => {
    const auto = settings('auto')
    const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id), name: 'fix-copy' })
    expect(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: { code: 'observed', values: { text: 'asked' } }, audit: { would_accept: true } })
    expect(assessmentOutcome(accept(auto, false), auto, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred')).toThrow('Acceptance requires intent_evidence')
    const scope = { scope: () => ({ listened: true as const, observed: true }) }
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
    expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
    expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
  })
})

describe('接单表设置', () => {
  it('拒绝未点名智能体消息的 explicit 单元格，设置与提交的策略中皆然', () => {
    for (const cell of ['listedUnaddressed', 'unlistedUnaddressed']) {
      const part = { allowed: [], admission: { [CHAT]: { [cell]: 'explicit' } } }
      expect(() => SettingsSchema.parse({ policy: { sources: { feishu: part } } })).toThrow()
      expect(() => sources.validatePolicy({ feishu: part })).toThrow()
    }
    expect(sources.validatePolicy({ feishu: { allowed: [], admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } }).feishu)
      .toMatchObject({ admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })
  })
  it('无论接单模式如何都接受 explicit 候选，模式只影响 inferred 候选', () => {
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })) }
    for (const mode of ['observe', 'off'] as const) {
      const settings = SettingsSchema.parse({ eval: { mode } })
      expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', title: 'Fix' })
      expect(assessmentOutcome(assessment, settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'observed' } })
    }
  })
  it('来源不观察消息时放行点名智能体的名单内机器人，正如名单内用户的点名无需观察', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } } })
    const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention', row: CHAT } })
  })
})
describe('规则研判', () => {
  it('拒绝把一个启用规则研判两次而另一条未研判的评估', () => {
    const parsed = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }] } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'typo' }, { rule_id: 'copy', matched: false, reason: 'again' }] }
    expect(() => assessmentOutcome(assessment, parsed, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    const once = { ...assessment, rule_assessments: [assessment.rule_assessments[0]!, { rule_id: 'visual', matched: false, reason: 'no colors' }] }
    expect(assessmentOutcome(once, parsed, 'inferred')).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })
})
describe('策略影响', () => {
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) })
  const base = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const ticket = (id: string, mandate: object) => ({ id, mandate } as unknown as Ticket)
  const inferred = ticket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = ticket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  it('告知工单变更对它的影响，不波及其他工单', () => {
    const rules = (copy: object, visual: object = {}) => ({ ...base, policy: { ...base.policy, rules: [{ ...base.policy.rules[0]!, ...copy }, { ...base.policy.rules[1]!, ...visual }] } })
    // 工单接受时未依据的规则对它没有影响。
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0)
    expect(policyEffects([inferred], base, rules({ instruction: 'Fix typos only.' }), scope).get('t1'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }] })
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get('t1')).toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
    // 成员同步新增名单上的另一个发送者不影响任何工单；把请求者移出名单则有影响。
    const allowed = (list: { id: string }[]) => ({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: list } } } })
    expect(policyEffects([inferred, explicit], base, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), scope).size).toBe(0)
    expect(policyEffects([explicit], base, allowed([]), scope).get('t2')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_alice' } })
  })
  it('接单模式离开 auto 时告知 inferred 工单不再接受 inferred 工作，并指明其归属的机器人', () => {
    const auto = { ...base, eval: { ...base.eval, mode: 'auto' as const } }
    const observe = { ...base, eval: { ...base.eval, mode: 'observe' as const } }
    const rule = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} } })
    const effects = policyEffects([rule, explicit], auto, observe, scope)
    // 并非发送者被移出名单：写下消息的人仍可发起工作。
    expect(effects.get('t3')).toEqual({ proactive: false })
    expect(effects.has('t2')).toBe(false)
    const bot = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
    const listed = { ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: [{ id: 'cli_ci_bot' }] } } } }
    expect(policyEffects([bot], listed, base, scope).get('t4')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'cli_ci_bot' } })
  })
  it('与其他 inferred 授权一样，inferred 后续消息的授权仅在候选可成为工作且其规则启用时保留', () => {
    const followup = ticket('t5', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'followup', source: 'feishu', scope: { chatId: 'oc_team' }, rules: ['copy'] } })
    const mode = (value: 'auto' | 'observe' | 'off') => ({ ...base, eval: { ...base.eval, mode: value } })
    const disabled = { ...mode('auto'), policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }
    expect(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate)).toBe(true)
    for (const settings of [mode('observe'), mode('off'), disabled]) expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false)
    expect(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5')).toEqual({ proactive: false })
    // explicit 后续消息无论模式如何都有效。
    const explicitFollowup = ticket('t6', { ...followup.mandate, strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' } })
    expect(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate)).toBe(true)
  })
  it('撤销单元格弱化或候选不再成为工作的 inferred 工单，并把已删除规则报告为停用', () => {
    const chat = 'oc_1111111111111111111111111111'
    const table = (cell: 'inferred' | 'ignore', mode: 'auto' | 'observe' = 'auto') => SettingsSchema.parse({ ...base, eval: { ...base.eval, mode },
      policy: { ...base.policy, sources: { feishu: { ...base.policy.sources.feishu!, admission: { [chat]: { unlistedUnaddressed: cell } } } } } })
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: chat }) })
    const proactive = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'feishu', scope: { chatId: chat }, row: chat, rules: ['copy'],
        observation: { mode: 'auto' } } })
    expect(policyEffects([proactive], table('inferred'), table('inferred'), observed).size).toBe(0)
    // 变弱的单元格收回发送者的工作，影响中指名该发送者；模式变更只是停止 inferred 工作。
    expect(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3'))
      .toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_guest' } })
    expect(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3')).toEqual({ proactive: false })
    const deleted = { ...base, policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== 'visual') } }
    const visual = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['visual'] } })
    expect(policyEffects([visual], base, deleted, scope).get('t4')).toEqual({ rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }] })
  })
})
describe('机器人与无发送者的事件', () => {
  const observing = (config: Record<string, unknown>, part: Record<string, unknown> = {},
    mode: 'auto' | 'off' = 'auto') => SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'Alice' }], bots: [{ id: 'dependabot[bot]' }], ...part } } }, eval: { mode },
    sources: { github: { enabled: true, config } } })
  const comment: Trigger = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash',
    meta: { number: 1, isPr: true, kind: 'conversation' } }
  const ci = (meta: Record<string, unknown>): Trigger => ({ id: 'ci', source: 'github', threads: [{ source: 'github', id: 'ci:main' }],
    actor: { source: 'github', id: '' }, human: false, at: '', text: 'CI failed 1/9 on main', meta: { ci: true, ...meta } })
  it('来源观察到其范围时，把其名单上的机器人作为 inferred 候选放行，其他机器人不行', () => {
    const { policy } = setup(observing({ observeComments: true }))
    expect(policy.gate(comment, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', source: 'github', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } } })
    // 点名智能体的机器人仍不构成明确的请求；在有工单的线程上也不算后续消息。
    expect(policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket])).toMatchObject({ strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention' } })
    expect(policy.gate({ ...comment, actor: { source: 'github', id: 'renovate[bot]' } }, thread(), [])).toEqual({ admissible: false,
      reason: 'not_human' })
    expect(setup(observing({})).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(setup(observing({ observeComments: true }, {}, 'off')).policy.gate(comment, thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
  })
  it('机器人留在名单且候选可成为工作期间保留其授权', () => {
    const settings = observing({ observeComments: true })
    const mandate = { strength: 'inferred' as const, policyVersion: '', actor: comment.actor, scope: '',
      basis: { via: 'bot' as const, source: 'github', scope: comment.meta, row: 'comments', sender: 'dependabot[bot]',
        observation: { mode: 'auto' as const } } }
    expect(setup(settings).policy.revalidate(mandate)).toBe(true)
    expect(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate)).toBe(false)
    expect(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate)).toBe(false)
  })
  it('默认分支的 CI 在被观察且设置后经其行放行，PR 的 CI 永不放行', () => {
    const admission = { ci: { unlistedUnaddressed: 'inferred' } }
    const branch = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ branch: 'main' }), thread(), [])
    expect(branch).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } } })
    // 单元格默认为 ignore，因此在接单表设置之前观察 CI 不改变任何行为。
    expect(setup(observing({ observeCi: true })).policy.gate(ci({ branch: 'main' }), thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
    const pull = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ number: 9, isPr: true }), thread(), [])
    expect(pull).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('在来源观察的群中放行名单上的飞书机器人', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } })
    const alert = unaddressed({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(setup(settings).policy.gate(alert, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot', sender: 'Alerts', row: OBSERVED } })
    // 在仅接收点名的群中，机器人未点名智能体的消息不会被接收。
    const unobserved = setup(settings).policy.gate({ ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } }, thread(), [])
    expect(unobserved).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('在 GitHub 机器人名单上说明名单内机器人的评论何时被接收：点名智能体时，或观察评论时', () => {
    const field = githubKind.policy!.fields.find(item => item.key === 'bots')!
    const comments = githubKind.fields.find(item => item.key === 'observeComments')!.label
    expect(field.hint!.en).toContain('mentions the agent')
    expect(field.hint!.en).toContain(comments.en)
    expect(field.hint!.zh).toContain(comments.zh)
  })
  it('指出 GitHub 触发的接收范围，来源在其开关打开处观察该范围', () => {
    const { sources } = setup(observing({ observeIssues: true }))
    const github = (meta: Record<string, unknown>) => ({ source: 'github', meta })
    expect(sources.scope(github({ kind: 'issue', number: 3 }))).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sources.scope(github({ kind: 'pull', number: 4, isPr: true }))).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(sources.scope(github({ kind: 'inline', number: 4 }))).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(sources.scope(github({ ci: true, branch: 'main' }))).toEqual({ listened: true, observed: false, row: 'ci' })
    expect(sources.scope(github({ ci: true, number: 4 }))).toEqual({ listened: true, observed: false })
    const rows = githubKind.policy!.rows!({ observeIssues: true })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ['issues', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ['pulls', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['ci', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
  })
})

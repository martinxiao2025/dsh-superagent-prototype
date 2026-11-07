import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Prompts, builtInBase, composePrompt, defaultPrompts, policySection, promptParts, type PromptConfig } from '../src/app/prompts.ts'
import { USER_ERRORS, UserError } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, policyVersion } from '../src/policy.ts'
import { guides, handoffPolicy, mainAdmissionPolicy, masterPrompt, sharedPrompt, workerPrompt } from '../src/app/context.ts'
import { promptFile } from '../src/app/skill-files.ts'
import { packagePath } from '../src/infra/paths.ts'
import type { Variable } from '../src/app/execution-environment.ts'

/** 工单之外的执行环境，即部署完成后运行时传入的形式。 */
const variables = (): Variable[] => [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', value: 'acme/widgets', description: { zh: '仓库', en: 'The repository' }, owner: 'github' }]
const ENVIRONMENT_LINE = '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets": 仓库。'
const promptsOf = (store: Store, maxChars = 100000) => new Prompts(store, () => maxChars, variables, () => true)
function withStore(body: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-')); const store = new Store(join(dir, 'db'))
  try { body(store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('把团队小节与 skill 保存为可跨重启存活的版本，带历史与回滚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-config-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = promptsOf(store)
    expect(prompts.current().config).toEqual(defaultPrompts())
    const config = { ...defaultPrompts(), scope: 'Finish what was asked.', delivery: '', skills: { release: 'Tag releases on Fridays.' } }
    prompts.save(config, 0, 'panel')
    expect(composePrompt(prompts.current().config, 'worker')).toContain('## 工单范围\nFinish what was asked.')
    // 空的团队小节不进入 prompt；固定小节保留。
    expect(promptParts(config, 'worker').map(part => part.name)).not.toContain('delivery')
    expect(store.get('settings-revision')).toBeUndefined()
    store.close(); store = new Store(join(dir, 'db')); prompts = promptsOf(store)
    expect(prompts.current()).toMatchObject({ revision: 1, config })
    prompts.save(prompts.version(0).config, 1, 'tool')
    expect(prompts.current()).toMatchObject({ revision: 2, previousRevision: 1, config: defaultPrompts() })
    expect(prompts.history(0, 1)).toMatchObject({ revisions: [{ revision: 2 }], next_offset: 1 })
    expect(prompts.history(2, 1).next_offset).toBeNull()
    expect(prompts.history(1, 1).revisions[0]).toMatchObject({ revision: 1, changed: ['scope', 'delivery', 'skill/release'] })
    expect(() => prompts.save(config, 1, 'panel')).toThrow('version changed')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('无论配置如何，都从围绕团队小节的固定小节组装每个角色', () => {
  const config = { communication: 'Say little.', scope: '', delivery: 'Attach screenshots.', skills: {} }
  for (const role of ['orchestrator', 'worker'] as const) {
    const names = promptParts(config, role, 'env').map(part => part.name)
    expect(names).toEqual(['runtime/shared', `runtime/${role}`, 'communication', 'delivery', 'runtime/subscriptions', 'runtime/replies', role === 'orchestrator' ? 'runtime/dispatch' : 'runtime/work', ...role === 'orchestrator' ? ['runtime/admission'] : [], 'runtime/handoff', 'runtime/environment'])
    const prompt = composePrompt(config, role)
    for (const fixed of [sharedPrompt, role === 'orchestrator' ? masterPrompt : workerPrompt, guides.subscriptions!, guides.replies!, handoffPolicy(role)]) expect(prompt).toContain(fixed)
    expect(prompt.endsWith(handoffPolicy(role))).toBe(true)
  }
  expect(composePrompt(config, 'orchestrator')).toContain(mainAdmissionPolicy)
  expect(composePrompt(config, 'worker')).not.toContain(mainAdmissionPolicy)
})

it('读取 prompt 文件时无论换行符与空行形式如何都一致，并对缺失或空文件指名报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-file-'))
  // promptFile 以 prompts/ 为基准解析路径；用相对路径指向临时目录。
  const name = (file: string) => relative(packagePath('prompts'), join(dir, file))
  try {
    writeFileSync(join(dir, 'crlf.md'), 'One.\r\nTwo. \r\n \t\r\n\r\nThree.\r\n')
    writeFileSync(join(dir, 'blank.md'), ' \n\t\n')
    expect(promptFile(name('crlf'))).toBe('One. Two.\nThree.')
    expect(() => promptFile(name('blank'))).toThrow(`Empty packaged file: ${join(dir, 'blank.md')}`)
    expect(() => promptFile(name('absent'))).toThrow(`Missing packaged file: ${join(dir, 'absent.md')}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('把界面修改前后证据留给团队可改的交付要求', () => {
  const config = { ...defaultPrompts(), delivery: 'Only capture the finished screen.' }
  for (const role of ['orchestrator', 'worker'] as const) expect(composePrompt(config, role)).not.toContain('Before and After visual evidence')
})

it.each(['orchestrator', 'worker'] as const)('%s prompt 以固定的交接规则与执行环境收尾，主 Session 的以策略收尾', role => {
  withStore(store => {
    const prompts = promptsOf(store)
    const preview = prompts.preview(defaultPrompts())
    expect(promptParts(defaultPrompts(), role).at(-1)).toEqual({ name: 'runtime/handoff', kind: 'fixed', key: `runtime/handoff/${role}`,
      text: handoffPolicy(role) })
    expect(preview[role]).toBe(prompts.compose(defaultPrompts(), role))
    expect(preview[role]).toContain(`${handoffPolicy(role)}\n\n执行环境`)
    if (role === 'worker') expect(preview[role].endsWith(ENVIRONMENT_LINE)).toBe(true)
    // 主 Session 的策略小节之后没有任何内容，因此策略变更不影响其 prompt 的其余部分。
    else expect(preview[role].endsWith(`${ENVIRONMENT_LINE}\n\n${policySection(store.settings()).text}`)).toBe(true)
    expect(preview.parts[role].at(-1)!.name).toBe(role === 'orchestrator' ? 'runtime/policy' : 'runtime/environment')
  })
})

it('在持久化之前拒绝未知键、内置 skill 名与超限的配置', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    expect(() => prompts.save({ ...defaultPrompts(), shared: 'x' }, 0, 'panel')).toThrow()
    expect(() => prompts.save({ communication: '', scope: '' }, 0, 'panel')).toThrow()
    for (const name of ['github', 'feishu']) expect(() => prompts.save({ ...defaultPrompts(), skills: { [name]: 'mine' } }, 0, 'panel')).toThrow('built-in skill')
    expect(() => prompts.save({ ...defaultPrompts(), skills: { 'Bad Name': 'x' } }, 0, 'panel')).toThrow()
    expect(() => promptsOf(store, 1000).save(defaultPrompts(), 0, 'panel')).toThrow('exceeds')
    expect(prompts.current().revision).toBe(0)
  })
})

it('在工单的 prompt 中列出其执行环境，部署未完成时提示 setup 未就绪', () => {
  withStore(store => {
    const ticket: Variable[] = [{ key: 'DSH_SUPERAGENT_DIR', value: '/srv/work/fix-1', description: { zh: '这个工单的执行目录', en: 'This ticket\'s directory' }, owner: 'executor' }]
    expect(promptsOf(store).compose(defaultPrompts(), 'worker', ticket).endsWith('- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": 这个工单的执行目录。')).toBe(true)
    expect(promptParts(defaultPrompts(), 'worker', 'env').at(-1)).toEqual({ name: 'runtime/environment', kind: 'generated', key: 'runtime/environment',
      text: 'env' })
    expect(new Prompts(store, () => 100000, () => undefined, () => false).compose(defaultPrompts(), 'worker')).toContain('正在等待 setup')
  })
})

it('在团队 skill 之前注册内置来源 skill，飞书仅在有飞书机器人时注册', () => {
  withStore(store => {
    const config = { ...defaultPrompts(), skills: { release: 'Tag releases.' } }
    const skills = promptsOf(store).skills(config)
    expect(skills.map(([name]) => name)).toEqual(['feishu', 'github', 'release'])
    expect(skills[1]![1]).toContain('## CLI 用法')
    expect(skills[2]![1]).toBe('Tag releases.')
    expect(new Prompts(store, () => 100000, variables, () => false).skills(config).map(([name]) => name)).toEqual(['github', 'release'])
  })
})


describe('内置部件的覆盖', () => {
  const settings = () => SettingsSchema.parse({})
  const config = (overrides: PromptConfig['overrides']) => ({ ...defaultPrompts(), overrides })
  it('按各读取角色在相应位置替代内置文本，包括按角色的交接与来源 skill', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/shared': { text: 'Shared, the team way.' }, 'runtime/dispatch': { text: '## dispatch\nRoute well.' },
        'runtime/handoff/worker': { text: 'Hand off as a worker.' }, 'skill/github': { text: 'GitHub, the team way.' } }))
      const main = prompts.compose(edited, 'orchestrator'), worker = prompts.compose(edited, 'worker')
      for (const prompt of [main, worker]) expect(prompt.startsWith('Shared, the team way.\n\n')).toBe(true)
      expect(main).toContain('## dispatch\nRoute well.')
      expect(main).not.toContain(guides.dispatch)
      expect(worker).toContain('Hand off as a worker.')
      expect(main).toContain(handoffPolicy('orchestrator'))
      expect(prompts.skills(edited)).toContainEqual(['github', 'GitHub, the team way.'])
      // 各部件标明其编辑依据。
      expect(promptParts(edited, 'worker').find(part => part.name === 'runtime/handoff')).toMatchObject({ key: 'runtime/handoff/worker',
        text: 'Hand off as a worker.' })
    })
  })
  it('用数据填充生成部件的模板，同时保持其为生成部件', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/environment': { text: 'Where you work:\n{variables}\nAsk nobody for more.' },
        'runtime/policy': { text: '## Policy\nRules of {version} in {mode} mode:\n{rules}' },
        'runtime/policy/none': { text: '## Policy\n{version}, {mode}: nothing to accept.' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`Where you work:\n${ENVIRONMENT_LINE}\nAsk nobody for more.`)).toBe(true)
      const policy = policySection(settings(), edited)
      expect(policy).toEqual({ key: 'runtime/policy', text: `## Policy\nRules of ${policyVersion(settings())} in ${settings().eval.mode} mode:\n`
        + settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n') })
      const none = SettingsSchema.parse({ policy: { rules: [] } })
      expect(policySection(none, edited)).toEqual({ key: 'runtime/policy/none', text: `## Policy\n${policyVersion(none)}, ${none.eval.mode}: nothing to accept.` })
      // 规则文本中的占位符名字不会再被填充。
      const named = SettingsSchema.parse({ policy: { rules: [{ id: 'x', name: 'X', enabled: true, instruction: 'Keep {mode} and $& as written.' }] } })
      expect(policySection(named, edited).text.endsWith('- X (x): Keep {mode} and $& as written.')).toBe(true)
    })
  })
  it('拒绝未知部件与丢失占位符的模板，并丢弃与内置文本相同的覆盖', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      expect(() => prompts.validate(config({ 'runtime/nothing': { text: 'x' } }))).toThrow(new UserError('unknownPromptPart', { part: 'runtime/nothing' }))
      expect(() => prompts.validate(config({ 'runtime/policy': { text: '## Policy\n{version} {mode}' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/policy', placeholders: '{rules}' }))
      expect(() => prompts.validate(config({ 'runtime/environment': { text: 'Where you work.' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/environment', placeholders: '{variables}' }))
      // 回到内置文本：部件重新跟随内置文本，之后的升级会更新它。
      expect(prompts.validate(config({ 'runtime/shared': { text: sharedPrompt } }))).not.toHaveProperty('overrides')
      // 整个配置（含覆盖）都受同一上限约束。
      expect(() => promptsOf(store, 5000).validate(config({ 'runtime/shared': { text: 'x'.repeat(5000) } }))).toThrow(UserError)
    })
  })
  it('记录覆盖编辑时依据的内置文本，并列出内置文本此后发生变化的覆盖', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      // 从当前内置文本编辑而来的覆盖没有变化可显示。
      const saved = prompts.save(config({ 'runtime/dispatch': { text: '## dispatch\nRoute well.' } }), 0, 'panel')
      expect(saved.config.overrides!['runtime/dispatch']!.base).toBe(builtInBase(`## 派工\n${guides.dispatch}`))
      expect(prompts.defaultChanged(saved.config)).toEqual([])
      // 一个从早期版本内置文本编辑而来的覆盖，保存时该安装保留了那份文本。
      const earlier = '## replies\nAn earlier built-in text.'
      store.set(KV.prompts.builtIn(builtInBase(earlier)), earlier)
      const upgraded = prompts.save(config({ ...saved.config.overrides, 'runtime/replies': { text: 'Our replies.', base: builtInBase(earlier) },
        'runtime/work': { text: 'Our work.', base: 'unknown' } }), saved.revision, 'panel')
      expect(prompts.defaultChanged(upgraded.config)).toEqual([{ part: 'runtime/replies', base: builtInBase(earlier), previous: earlier },
        { part: 'runtime/work', base: 'unknown' }])
      // 保持原样：升级从不替换团队的文本。
      expect(prompts.compose(prompts.current().config, 'worker')).toContain('Our replies.')
    })
  })
  it('原样读取覆盖功能出现之前保存的配置', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const saved = prompts.save({ ...defaultPrompts(), communication: 'Ours.' }, 0, 'panel')
      expect(saved.config).toEqual({ ...defaultPrompts(), communication: 'Ours.' })
      expect(prompts.compose(saved.config, 'orchestrator')).toBe(prompts.compose({ ...defaultPrompts(), communication: 'Ours.', overrides: {} }, 'orchestrator'))
    })
  })
  it('丢弃后续版本已不含、但保存版本仍持有的部件的覆盖，并将其列为已移除', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const config = { ...defaultPrompts(), overrides: { 'runtime/retired': { text: 'Old.', base: 'b' } } }
      // 只有保存版本持有的部件会被悄悄丢弃；客户端凭空编造的会被拒绝。
      expect(() => prompts.validate(config)).toThrow(new UserError('unknownPromptPart', { part: 'runtime/retired' }))
      store.set(KV.prompts.version(1), { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config }); store.set(KV.prompts.revision, 1)
      expect(prompts.defaultChanged(config)).toEqual([{ part: 'runtime/retired', base: 'b', removed: true }])
      expect(prompts.validate(config)).toEqual(defaultPrompts())
      expect(USER_ERRORS.unknownPromptPart[0]).toBe('refused')
    })
  })
  it('保存省略 base 时保留已存覆盖的 base，并把重新基于的覆盖显示为一次变更', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const first = prompts.save(config({ 'runtime/shared': { text: 'Ours.', base: 'earlier' } }), 0, 'panel')
      const second = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.' } }), first.revision, 'tool')
      expect(second.config.overrides!['runtime/shared']).toEqual({ text: 'Ours, edited.', base: 'earlier' })
      // 升级后保留团队文本只改变 base，历史中会记录该变更。
      const rebased = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.', base: builtInBase(sharedPrompt) } }), second.revision, 'panel')
      expect(prompts.history().revisions.find(version => version.revision === rebased.revision)!.changed).toEqual(['runtime/shared'])
    })
  })
  it('拒绝对象原型链上的属性名作为部件名与空文本，且不填充原型链名字的占位符', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      for (const part of ['constructor', 'toString']) {
        expect(() => prompts.validate(config(JSON.parse(`{"${part}": { "text": "x" }}`)))).toThrow(new UserError('unknownPromptPart', { part }))
      }
      // 解析器丢弃 __proto__ 键，不会设置原型。
      expect(prompts.validate(config(JSON.parse('{"__proto__": { "text": "x" }}')))).toEqual(defaultPrompts())
      expect(() => prompts.validate(config({ 'runtime/shared': { text: ' \n ' } }))).toThrow(new UserError('promptPartEmpty', { part: 'runtime/shared' }))
      const edited = prompts.validate(config({ 'runtime/environment': { text: '{constructor} {toString}\n{variables}' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`{constructor} {toString}\n${ENVIRONMENT_LINE}`)).toBe(true)
    })
  })
  it('保持执行环境标题原样，并提及 prepare 命令', () => {
    expect(composePrompt(defaultPrompts(), 'worker', 'x')).not.toContain('prepare 命令')
    withStore(store => {
      expect(promptsOf(store).compose(defaultPrompts(), 'worker')).toContain('空值表示该部分未在此配置）。'
        + `工单目录的 prepare 命令读取同样的变量：\n${ENVIRONMENT_LINE}`)
    })
  })
})

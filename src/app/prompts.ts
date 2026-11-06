/** 独立于访问设置，管理版本化的角色提示词、行为策略与运维技能。 */
import { z } from 'zod'
import { UserError, key } from '../core/index.ts'
import { policyVersion, type Settings, type SettingsOrigin } from '../policy.ts'
import { masterPrompt, workerPrompt, sharedPrompt, guides, mainAdmissionPolicy, handoffPolicy, teamDefaults, sourceSkills, cliNotes } from './context.ts'
import { environmentLines, type Variable } from './execution-environment.ts'
import { promptsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import { Versions } from './versions.ts'
import { KV } from '../kv.ts'

/** 团队编写的提示词片段；在被团队覆盖之前，内置片段沿用 dsh-superagent 的文本。 */
export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type TeamSection = typeof TEAM_SECTIONS[number]
/** 每个团队片段的 Markdown 标题；固定提示词片段以这些确切名称引用它们。 */
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
/** 在 DSH Session 中注册技能时加在技能名前的固定前缀。 */
export const SKILL_PREFIX = 'dsh-superagent-'
const SkillNameSchema = z.string().regex(SKILL_NAME).refine(name => !(Object.keys(sourceSkills) as string[]).includes(name),
  'This name belongs to a built-in skill')
/** 团队可覆盖的内置片段，按 key 索引：两个角色的片段、Source 技能，以及生成片段的模板。 */
const PART_KEYS = ['runtime/shared', 'runtime/orchestrator', 'runtime/worker', 'runtime/subscriptions', 'runtime/replies',
  'runtime/dispatch', 'runtime/work', 'runtime/admission', 'runtime/handoff/orchestrator', 'runtime/handoff/worker', 'runtime/environment',
  'runtime/policy', 'runtime/policy/none', 'skill/feishu', 'skill/github'] as const
export type PartKey = typeof PART_KEYS[number]
/** 团队为某个内置片段写的文本，以及 `base`——它所编辑自的内置文本的 key。 */
const OverrideSchema = z.object({ text: z.string(),
  base: z.string().optional().describe('Key of the built-in text it was edited from; copy as read, or omit.') }).strict()
/**
 * 一种配置：其覆盖项可能指向后续版本已不再拥有的片段——当已保存版本仍持有它时 `Prompts.validate` 会丢弃它，
 * 否则直接拒绝。
 */
export const PromptConfigSchema = z.object({ communication: z.string(), scope: z.string(), delivery: z.string(),
  skills: z.record(SkillNameSchema, z.string()), overrides: z.record(z.string(), OverrideSchema).optional()
    .describe('Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.') }).strict()
export type PromptConfig = z.infer<typeof PromptConfigSchema>
export interface PromptVersion { revision: number; previousRevision: number | null; savedAt: string; source: string; config: PromptConfig;
  /** 当差异无法跨 schema 版本比较时保留的原始未迁移配置。 */
  legacy?: { config: unknown } }
export const defaultPrompts = (): PromptConfig => ({ ...teamDefaults, skills: {} })

const ENVIRONMENT_HEADING = '执行环境（来自本安装的设置；它优先于这些指令中其他任何位置提到的仓库或账号；空值表示该部分在此处未配置）。工单目录的 prepare 命令读取同一组变量：'
const POLICY_HEAD = '## Policy\nPolicy 版本 {version}；accept 模式 {mode}。accept 模式与规则只决定主动候选：显式请求按 dispatch 所述路由，在任何模式下、无论规则如何。'
type Role = 'orchestrator' | 'worker'
/** 团队可覆盖的内置片段：读取它的角色、它的文本，以及模板覆盖必须保留的占位符。 */
interface BuiltInPart { roles: readonly Role[]; text: string; placeholders?: readonly string[] }
const BOTH: readonly Role[] = ['orchestrator', 'worker'], MAIN: readonly Role[] = ['orchestrator'], WORKER: readonly Role[] = ['worker']
let parts: Readonly<Record<PartKey, BuiltInPart>> | undefined
/**
 * 两个角色提示词的内置片段、两个 Source 技能，以及由系统填入数据的生成片段模板，都按覆盖项引用它们时的 key 索引。
 * 在首次使用时构建，因为它读取的文本处于循环导入中。
 */
export const builtInParts = (): Readonly<Record<PartKey, BuiltInPart>> => parts ??= {
  'runtime/shared': { roles: BOTH, text: sharedPrompt }, 'runtime/orchestrator': { roles: MAIN, text: masterPrompt },
  'runtime/worker': { roles: WORKER, text: workerPrompt },
  'runtime/subscriptions': { roles: BOTH, text: `## subscriptions\n${guides.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## replies\n${guides.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## dispatch\n${guides.dispatch}` }, 'runtime/work': { roles: WORKER, text: `## work\n${guides.work}` },
  'runtime/admission': { roles: MAIN, text: mainAdmissionPolicy },
  'runtime/handoff/orchestrator': { roles: MAIN, text: handoffPolicy('orchestrator') },
  'runtime/handoff/worker': { roles: WORKER, text: handoffPolicy('worker') },
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEADING}\n{variables}`, placeholders: ['{variables}'] },
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD} The enabled rules, by name and id:\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD} No rule is enabled: a proactive candidate can only be ignored.`,
    placeholders: ['{version}', '{mode}'] },
  'skill/feishu': { roles: BOTH, text: `${sourceSkills.feishu}\n\n## CLI usage\n${cliNotes}` },
  'skill/github': { roles: BOTH, text: `${sourceSkills.github}\n\n## CLI usage\n${cliNotes}` },
}
/** 某个内置文本的 key，由覆盖项的 `base` 记录。 */
export const builtInBase = (text: string): string => key('prompt-built-in', text)
/** key 所指的内置片段；对象原型上的名称不指向任何片段。 */
export const builtInPart = (part: string): BuiltInPart | undefined =>
  Object.hasOwn(builtInParts(), part) ? builtInParts()[part as PartKey] : undefined
/** 内置片段的文本：团队的覆盖文本，否则为内置文本。 */
const builtIn = (config: PromptConfig, part: PartKey): string =>
  (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part]!.text : undefined) ?? builtInParts()[part].text
/** 一次替换模板中的全部占位符，使填入的文本不会被再次当作占位符解析。 */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match)
/** 执行环境片段：带入变量的模板；setup 仍在等待时则说明正在等待。 */
export function environmentSection(config: PromptConfig, variables: Variable[] | undefined): string {
  return variables ? fill(builtIn(config, 'runtime/environment'), { variables: environmentLines(variables) })
    : '执行环境：dsh-superagent 正在等待 setup；管理面板会指出缺少什么。'
}
/**
 * 主 Session 的 Policy 片段：它据以判断主动候选的 Policy 版本与 accept 模式，以及设置中保存的每条已启用规则，
 * 每条规则占一行，使某条指令的一行不会被当作规则或标题；设置会限定每条指令的长度（`LIMITS.ruleInstruction`）。
 * `key` 指明它由哪个模板填充。
 */
export function policySection(settings: Settings, config: PromptConfig = defaultPrompts()): { key: string; text: string } {
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ')
  const rules = settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`)
  const part = rules.length ? 'runtime/policy' : 'runtime/policy/none'
  return { key: part, text: fill(builtIn(config, part), { version: policyVersion(settings), mode: settings.eval.mode, rules: rules.join('\n') }) }
}
/**
 * 按顺序从固定模板、团队片段、生成的执行环境，以及最后是主 Session 生成的 Policy 片段组装某个角色的系统提示词片段；
 * Policy 片段之后不再有任何内容，其变化不影响其余部分。
 */
export function promptParts(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }) {
  // 内置片段以其文本被覆盖时的 key 命名，对 handoff 而言该 key 也指明了角色。
  const fixed = (name: string, part = name) => ({ name, kind: 'fixed' as const, key: part, text: builtIn(config, part as PartKey) })
  const team = (name: TeamSection) => ({ name, kind: 'team' as const, heading: `## ${TEAM_HEADINGS[name]}`,
    text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : '' })
  return [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(team),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed('runtime/handoff', `runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated' as const, key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated' as const, ...policy }] : [],
  ].filter(part => part.text)
}
export function composePrompt(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }): string {
  return promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')
}
export function composeSkill(config: PromptConfig, name: string): string {
  return name === 'feishu' || name === 'github' ? builtIn(config, `skill/${name}`) : config.skills[name] ?? ''
}

/** 内置文本自其 `base` 以来已变化的覆盖项（保留时附带该文本），或本版本已不再拥有的片段覆盖项。 */
export interface DefaultChange { part: string; base?: string; previous?: string; removed?: true }
/**
 * 基于过期修订保存提示词配置时表示乐观并发冲突。
 * 由 `Prompts.save` 抛出，并由管理路由转换为 HTTP 409 响应。
 */
export class PromptConflict extends Error {}
/**
 * 通过 `Versions` 在 `Store` 中存储编号的提示词配置，并结合执行环境合成角色系统提示词与技能。
 * `Sessions` 读取合成后的提示词与技能用于 orchestrator 与 worker 运行，管理路由与工具则通过它校验、预览并保存修订。
 */
export class Prompts {
  private readonly versions: Versions<PromptVersion>
  constructor(private readonly store: Store, private readonly maxChars: () => number, private readonly environment: () => Variable[] | undefined,
    private readonly feishu: () => boolean) {
    this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version)
  }
  /** 某个角色的提示词；主 Session 的 Policy 片段在每次模型请求时跟随当前设置。 */
  compose(config: PromptConfig, role: Role, variables = this.environment()): string {
    return composePrompt(config, role, environmentSection(config, variables), role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
  }
  /** 返回要在每个 Session 注册的技能：先内置 Source 技能（仅当配置了飞书机器人时才含 `feishu`），随后是团队技能。 */
  skills(config: PromptConfig): [string, string][] {
    return [...this.feishu() ? ['feishu'] : [], 'github', ...Object.keys(config.skills)].map(name => [name, composeSkill(config, name)])
  }
  current(): PromptVersion {
    const revision = this.versions.revision()
    return revision ? this.version(revision) : { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() }
  }
  /** 按编号读取某个修订；第 0 版在首次保存持久化之前解析为内置默认值。 */
  version(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0 ? this.current() : undefined)
    if (!version) throw new UserError('unknownPromptRevision', { revision: String(revision) })
    return version
  }
  /**
   * 解析配置：覆盖项必须指向内置片段、包含文本并保留其模板的占位符，同时记录它所编辑自的内置文本
   * （已保存覆盖项已指明的除外，否则用当前内置文本）。覆盖文本与内置文本相同时该覆盖项被移除，
   * 本版本已不再拥有、但已保存版本仍有记录的片段覆盖项同样移除。
   */
  validate(value: unknown): PromptConfig {
    const { overrides, ...config } = PromptConfigSchema.parse(value)
    const saved = this.current().config.overrides ?? {}
    const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
      const part = builtInPart(name)
      if (!part && Object.hasOwn(saved, name)) return []
      if (!part) throw new UserError('unknownPromptPart', { part: name })
      if (!override.text.trim()) throw new UserError('promptPartEmpty', { part: name })
      const missing = (part.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) throw new UserError('promptPlaceholders', { part: name, placeholders: missing.join(', ') })
      const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name]!.base : undefined) ?? builtInBase(part.text)
      return override.text === part.text ? [] : [[name, { text: override.text, base }] as const]
    })
    const result: PromptConfig = { ...config, ...kept.length ? { overrides: Object.fromEntries(kept) } : {} }
    const limit = this.maxChars()
    if (JSON.stringify(result).length > limit) throw new UserError('promptTooLong', { limit: String(limit) })
    return result
  }
  /**
   * `config` 中自团队编辑以来内置片段已发生变化的覆盖项，按其编辑来源 `base` 索引；若本安装保留了该 base 的内置文本
   * 则一并返回该文本，此外还包括本版本已不再拥有的片段覆盖项。
   */
  defaultChanged(config: PromptConfig): DefaultChange[] {
    return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]): DefaultChange[] => {
      const now = builtInPart(part)
      if (!now) return [{ part, ...base === undefined ? {} : { base }, removed: true as const }]
      if (base === undefined || base === builtInBase(now.text)) return []
      const previous = this.store.get(KV.prompts.builtIn(base))
      return [{ part, base, ...previous === undefined ? {} : { previous } }]
    })
  }
  preview(value: unknown) {
    const config = this.validate(value)
    const environment = environmentSection(config, this.environment()), policy = policySection(this.store.settings(), config)
    return { orchestrator: composePrompt(config, 'orchestrator', environment, policy), worker: composePrompt(config, 'worker', environment),
      parts: { orchestrator: promptParts(config, 'orchestrator', environment, policy), worker: promptParts(config, 'worker', environment) },
      skills: Object.fromEntries(this.skills(config)), scope: '团队片段、技能，以及内置片段的覆盖项，覆盖项在被覆盖之前沿用其内置文本。worker 还会继承宿主提示词与仓库的 AGENTS.md。提示词文本改变的是告知智能体的内容，而不是 dsh-superagent 允许的内容：工具权限、准入校验与账号包装保持不变。' }
  }
  save(value: unknown, baseRevision: number, source: SettingsOrigin): PromptVersion {
    const config = this.validate(value)
    return this.store.atomic(() => {
      const previous = this.current()
      if (previous.revision !== baseRevision) throw new PromptConflict(`提示词版本已变更为 ${previous.revision}；保存前请先对比最新版本`)
      // 在记录第一个自定义修订之前，先把内置默认值持久化为第 0 版。
      if (previous.revision === 0 && !this.versions.get(0)) this.versions.keep(previous)
      // 每个覆盖项编辑时所依据的内置文本，保留下来以展示升级对它的改动。
      for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
        const text = builtInParts()[part as PartKey].text
        if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === undefined) this.store.set(KV.prompts.builtIn(base), text)
      }
      return this.versions.save(revision => ({ revision, previousRevision: previous.revision, savedAt: new Date().toISOString(), source, config }))
    })
  }
  history(offset = 0, limit = 20) {
    const current = this.current()
    const revisions = Array.from({ length: Math.min(limit, Math.max(0, current.revision + 1 - offset)) }, (_, i) => {
      const version = current.revision - offset - i === 0 && current.revision === 0 ? current : this.version(current.revision - offset - i)
      const { config, ...summary } = version
      const previous = version.previousRevision === null ? undefined : this.versions.get(version.previousRevision)?.config
      // 团队片段出现之前的修订无法逐字段比较。
      const legacy = version.legacy || (version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy)
      if (legacy) return { ...summary, changed: ['legacy'] }
      const entries = (value: PromptConfig) => ({ communication: value.communication, scope: value.scope, delivery: value.delivery,
        ...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ['skill/' + name, text])),
        // 覆盖项随其文本变化，或随其所编辑自的内置文本变化。
        ...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)])) })
      const before = previous ? entries(previous) : {}
      const after = entries(config)
      const changed = previous ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before as Record<string, string>)[name] !== (after as Record<string, string>)[name]) : []
      return { ...summary, changed }
    })
    return { revisions, next_offset: offset + revisions.length <= current.revision ? offset + revisions.length : null }
  }
}
/** 保存新的提示词修订，并在变更来自其自身工具调用之外时通知主 Session。 */
export async function savePrompts(host: { store: Pick<Store, 'atomic'>; prompts: Pick<Prompts, 'save'>; sessions: Pick<Sessions, 'notify' | 'delivery'> },
  config: unknown, baseRevision: number, origin: SettingsOrigin) {
  const version = host.store.atomic(() => {
    const saved = host.prompts.save(config, baseRevision, origin)
    if (origin !== 'tool') host.sessions.notify(...promptsNotice(saved.revision))
    return saved
  })
  return { revision: version.revision, effect: 'next-request' as const, context_delivery: await host.sessions.delivery('prompts') }
}

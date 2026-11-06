/**
 * 运行时设置的 schema、评估校验与 policy 闸门判定。
 * 谁可以发起工作由各 Source 在自身身份配置中设定；Policy 绝不会把同一个人跨 Source 映射。
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** 检查评估是否确立了实现意图，且目标已确定、没有悬而未决的设计决策。 */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
}
/**
 * 依据已启用的规则校验评估，并将其转换为引擎的 `AssessmentOutcome`。
 * 接受需要方向已确定、至少命中一条已启用规则，以及 `intent_evidence`；推断候选只在 `auto` 模式下才会被接受
 * （否则记为 `would_accept`）。
 * @throws 当 `rule_assessments` 没有恰好覆盖每条已启用规则一次，或接受时缺少 `intent_evidence`。
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** 一条评估规则；其 instruction 还可以指定 PR 评审人以及是否等待其批准。 */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor 设置：worker 模型、并发数、ticket 目录根（留空时默认 `<stateDir>/work`）、`prepare` 命令与被阻止的命令。 */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
}).strict()
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

export const POLICY_REVISION = 'mandate-v3'
/**
 * 为影响工作授权的设置计算版本哈希。
 * 模型、并发数、暂停状态或轮询间隔的变更不会使已有决策失效。
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** 在 Source 的 `bots` policy 列表中查找 `actor`（由 Source 的种类校验），其消息最多只能作为推断候选被准入。 */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** 检查某个 thread 是否拥有自己的 ticket（不含仅用于上下文的订阅）。 */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** 计算从 `old` 变为 `now` 的设置变更如何影响每个开放 ticket 的授权或已命中规则。 */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // 在原有的接受模式与规则下，除非发送者或接收 scope 失去授权，否则 Mandate 继续有效。
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** 构建生效中的 Policy，用于对进入的 Trigger 做闸门判定，并对已有 Ticket 的 Mandate 重新校验。 */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** 对非人类触发做闸门判定：只有名单内的机器人（作为推断候选）以及无发送者的系统/CI 事件可以通过；其他机器人一律拒绝。 */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // 只有当 Source 能观察到该 scope 内的全部消息时，未明确指向的消息才会使用准入表。
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // 先检查显式准入单元格，再考虑 thread 后续消息，以免 thread 上的 ticket 把显式请求弱化为后续跟进。
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // 直接消息 thread 只属于一个发送者（其他人没有后续跟进），而推断的后续跟进要求接受模式不为 off（off 时由表格决定）。
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // 重新校验规则遵循 docs/002（Eval 路径；Resume 会重新校验）。
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // 显式的后续跟进继续有效；推断的后续跟进要求 auto 模式且命中的规则已启用。
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // 机器人的候选只有在它仍在所在 Source 的机器人列表中，并通过下面的观察检查时才成立。
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // 准入表产生的 Mandate 在发送者当前单元格仍授予至少原有强度时继续有效。
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // 名单内的发送者只要明确对 agent 说话就总是显式的，且不使用任何表格单元格。
        if (cell === 'unlistedAddressed' && listed) return true
        // 接受之后才加入允许列表的发送者会转入名单内单元格，并且仍需经过下面的观察检查。
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // 观察/推断得出的 Mandate 只有在 auto 模式生效且所有命中规则保持启用时才成立。
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}

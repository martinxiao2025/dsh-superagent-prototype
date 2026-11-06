/** Evals：对排队 Trigger 的 Thread 级评估，以及它们最终形成的 Decision。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { liveTicket, threadKey } from './model.ts'
import type { Decision, DecisionKind, Evaluation, Mandate, MandateBasis, Strength, Thread, Trigger } from './model.ts'
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

/** 针对持有某个 Trigger 的 Eval 的结果；`evalId` 指明它是为哪个 Eval 判定的，之后的 Eval 会拒绝它。 */
export type Outcome = AssessmentOutcome & { evalId?: string }
/** Eval 结束时产出的内容，即其 Decision 所记录的内容。 */
interface Finished { kind: DecisionKind; reason: Reason[]; audit?: Record<string, unknown>; ticketId?: string; mandate?: Mandate }
/** 结果的原因：它携带的码，否则是评估者或人所写的文字。 */
const reasonOf = (reason: string | Reason): Reason[] => [typeof reason === 'string' ? said(reason) : reason]
const stronger = (a: Strength, b: Strength): Strength => a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred'
/** 过期的 Eval 在记为 unavailable 之前，连续把其 Trigger 重新排队的最大次数。 */
const REQUEUES = 2

/**
 * Evals 负责运行 Thread 的评估：把一个 Thread 排队的 Trigger 合并为一次 Eval，从闸门取得其强度、行为者与 basis，
 * 询问评估者，在暂停期间保持其截止时间，并记录它最终形成的 Decision：accept、stop、ignore 或 unavailable。
 * 它依赖 Tickets 创建 accept 所决定的 ticket、结束 stop 所指的 ticket；Engine 把主 Session 的决策、人的重放、
 * worker 交还以及每轮的 Eval 工作路由到这里。
 */
export class Evals extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  /**
   * 让超过截止时间的 Thread Eval 过期（见 `expire`），除非处理已暂停：此时该 Eval 记下暂停开始的时刻，恢复后其截止
   * 时间顺延暂停时长。候选尚未抵达评估者 Session 的 Eval 不会过期。
   */
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return
    const now = this.now()
    if (policy.paused) evaluation.pausedAt = now
    else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString()
      delete evaluation.pausedAt
    } else if (evaluation.delivered && evaluation.deadline <= now) { this.expire(thread); return }
    else return
    this.repo.threads.save(thread)
  }
  /** Eval 的候选已抵达评估者 Session：其截止时间从此起算。 */
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find(item => item.evaluating?.id === evalId)
    if (!thread?.evaluating || thread.evaluating.delivered) return
    const now = this.now()
    thread.evaluating.delivered = now
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString()
    this.repo.threads.save(thread)
  }
  /**
   * 超过截止时间的 Eval 会将其 Trigger 重新排入新的 Eval，连续最多 `REQUEUES` 次，以免繁忙的评估者丢弃请求；
   * 之后则记为 unavailable。
   */
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1
    if (expired > REQUEUES) { this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [{ code: 'timeout' }] }); return }
    const { id, triggerIds } = thread.evaluating!
    delete thread.evaluating
    thread.expired = expired
    thread.pending = [...triggerIds, ...thread.pending.filter(item => !triggerIds.includes(item))]
    this.repo.threads.save(thread)
    this.options.assessor.release?.(id)
  }
  /** 对某个 Thread 上排队的 Trigger 启动一次 Eval，由闸门判定，并向评估者发起请求。 */
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!
    const at = this.now()
    // 仍由某个 ticket 裁决的人的后续消息属于该 ticket：旧版本排入队列的会在没有 Decision 的情况下离开队列。
    const delivered = (id: string) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger && this.owners(trigger).length > 0
    }
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered)
      thread.pending = thread.pending.filter(id => !followups.includes(id))
      this.repo.threads.save(thread)
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId })
      if (!thread.pending.length) return
    }
    // 已经产生过 ticket 的 Trigger 不能为新评估提供授权，也不能生成重复 ticket。
    const accepted = this.accepted(thread.key)
    const started = thread.pending.filter(id => accepted.has(id))
    const startedTicket = (id: string): Reason => ({ code: 'startedTicket', triggerId: id, values: { ticket: accepted.get(id)!.ticketId! } })
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at)
    const triggers = thread.pending.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const tickets = this.ticketsOnThread(thread)
    const reasons: Reason[] = []
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) { reasons.push({ code: gate.reason, triggerId: trigger.id }); continue }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at
      const weaker = !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis }
    }
    if (!strongest) {
      if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: 'noAdmissible' }], policy, at)
      this.repo.threads.save(thread)
      return
    }
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending)
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString()
    const { strength, trigger: { actor }, basis } = strongest
    thread.evaluating = { id: evalId, threadKey: thread.key, triggerIds: thread.pending, primary: strongest.trigger.id, strength, actor, basis,
      policyVersion: policy.version, startedAt: at, deadline }
    thread.pending = []
    this.repo.threads.save(thread)
    for (const trigger of triggers) {
      this.repo.triggers.saveDisposition(trigger.id, { ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }), evalId })
    }
    this.emit('eval.started', { evalId, threadKey: thread.key, triggerIds: thread.evaluating.triggerIds, strength: strongest.strength })
    this.options.assessor.request(this.candidateOf(thread))
  }
  /** 持有 `triggerId` 的那个 Eval 的候选；没有 Eval 持有时为 undefined。 */
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId)
    return thread && this.candidateOf(thread)
  }
  /**
   * 裁决一个 Trigger：由持有它的 Eval 裁决，若无则对它单独做一次直接 Eval。
   * @throws UserError 当 Trigger 未知或不可准入、`outcome.evalId` 指向已结束的 Eval、某个 ticket 的 worker 仍在裁决
   * 该 Trigger 而结果不是 stop，或在 `auto` 之外、或没有已启用且命中的规则时接受推断候选。
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const held = this.holding(triggerId)
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError('evalFinished', { eval: outcome.evalId })
    // 防止已创建过 ticket 的重放 trigger 再生成第二个 ticket。
    const earlier = outcome.kind === 'accept' ? this.accepted(threadKey(trigger.threads[0]!)).get(triggerId) : undefined
    if (earlier) {
      // 只有旧版本启动的 Eval 仍可能持有它；对其余 trigger 不带它重新评估，若只有它则忽略。
      const others = held?.evaluating?.triggerIds.filter(id => id !== triggerId) ?? []
      if (held && others.length) this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [triggerId])
      else if (held) {
        this.finish(held, held.evaluating!, { kind: 'ignore', reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }] })
      }
      return earlier
    }
    // 已抵达 ticket 的后续消息由其 worker 裁决：主 Session 只能停止其上的工作。
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger)
    const thread = held ?? this.thread(trigger.threads[0]!)
    const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === 'stop' ? outcome.ticketId : undefined)
    // 推断候选只有在评估命中的规则均已启用时才被接受，而评估本身可以接受。
    if (outcome.kind === 'accept' && evaluation.strength !== 'explicit' && !this.policy().admitsInferred(outcome.rules ?? [])) {
      throw new UserError('notExplicit')
    }
    return this.decideEval(thread, evaluation, outcome)
  }
  /**
   * 将已存储的 Trigger 排入其主 Thread 的新 Eval，并发出 `trigger.requeued`；当某个 Eval 持有时返回 false。
   * @throws UserError 当 Trigger 未知。
   */
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false
    this.emit('trigger.requeued', { triggerId })
    return true
  }
  /** 将 Trigger 排入其主 Thread 的新 Eval；当某个 Eval 持有时返回 false。 */
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (this.holding(triggerId)) return false
    this.queueForEval(trigger)
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() }
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true })
    return true
  }
  /**
   * 记录某个 ticket 的 Executor 将已抵达它、但超出该 ticket 范围的 Trigger 交还；当该 ticket 裁决过它且没有其他 ticket
   * 仍在裁决时，把它排入新的 Eval（见 `handBack`）：闸门会像对待其 Thread 上的任何消息一样判定它，其候选会携带原因，
   * 因此之前不会出现重新排队的通知。ticket 保留其订阅，且每个 Trigger 只交还一次。
   * @returns 是否已排队：当另一个 ticket 仍在裁决它，或该 ticket 并未裁决它时为 false。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)) throw new UserError('notReached')
    if (this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)) throw new UserError('handedBack')
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason)
  }
  /**
   * 把某个 `unavailable` 的 Decision 标记为已忽略，使概览不再列出它。
   * @throws UserError 当 Decision 未知或并非 `unavailable`。
   */
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId)
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem')
    decision.dismissed = true
    this.repo.decisions.save(decision)
    return decision
  }
  /** 因 Trigger 已被手动路由，将其从所在 Thread 的队列中取出。 */
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (!thread?.pending.includes(trigger.id)) return
    thread.pending = thread.pending.filter(id => id !== trigger.id)
    this.repo.threads.save(thread)
  }
  /**
   * 结束持有某个已路由到 ticket 的 Trigger 的 Eval（ticket 现在已拥有它）：若该 Eval 还持有其他 Trigger，
   * 会在不带它的情况下把它们重新排入新的 Eval。
   */
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId)
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } }
    if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] })
    else if (held) this.reassess(held, { ...reason, triggerId }, [triggerId])
  }
  /** 在新 Policy 版本下重新启动进行中的 Eval，并说明 Policy 已变更。 */
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' })
    this.emit('policy.changed', { from, to })
  }
  /** 以 `reason` 为由把某个 Thread 的 Eval 结束为 unavailable，并把其 Trigger（`without` 除外）排入新的 Eval，且优先于其他。 */
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter(id => !without.includes(id))
    const decision = this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [reason] })
    const current = this.repo.threads.get(thread.key)!
    current.pending = [...ids, ...current.pending.filter(id => !ids.includes(id))]
    this.repo.threads.save(current)
    return decision
  }
  /** 其 Eval 持有某个 Trigger 的 Thread：Eval 运行在它所持有的每个 Trigger 的主 Thread 上。 */
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId)
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined
  }
  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!
    const triggers = evaluation.triggerIds.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const { id: evalId, strength, policyVersion } = evaluation
    return { evalId, thread, triggers, strength, policyVersion, tickets: this.ticketsOnThread(thread) }
  }
  /**
   * 记录某个 Thread 排队中的 Trigger `ids` 因 `reason` 而不会启动 Eval，并把它们从队列中取出。其 id 与 Eval 的不同，
   * 因此绝不会替换同一批 Trigger 早先 Eval 的 Decision。
   */
  private ignore(thread: Thread, ids: string[], reason: Reason[], policy: Policy, at: string): void {
    const evaluation = { id: key('eval', thread.key, 'ignored', policy.version, at, ...ids), threadKey: thread.key, triggerIds: ids, strength: 'inferred' as const,
      actor: { source: thread.ref.source, id: '' }, basis: { via: 'followup' as const }, policyVersion: policy.version, startedAt: at, deadline: at }
    this.record(thread, evaluation, { kind: 'ignore', reason })
    thread.pending = thread.pending.filter(id => !ids.includes(id))
    delete thread.expired
  }
  /**
   * 主 Thread 为 `threadKey` 的那些 Trigger 的 accept Decision，按 Trigger 索引：即每个 Trigger 启动了哪个 ticket。
   * Eval 及其 Decision 在其 Trigger 的主 Thread 上运行，因此按索引读取该 Thread 的 Decision 就能全部得到。
   */
  private accepted(threadKey: string): Map<string, Decision> {
    const accepted = new Map<string, Decision>()
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (decision.kind !== 'accept' || !decision.ticketId) continue
      for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision)
    }
    return accepted
  }
  /**
   * 针对单个 Trigger 的仅走闸门的 Eval，用于没有排队 Eval 时直接裁决的结果，例如抵达 ticket 的后续消息。
   * 它立即被裁决，可与该 Thread 进行中的 Eval 并存，并把该 Trigger 从队列中取出。其 id 包含结果的种类，
   * 因此针对同一条消息同时发生的 stop 与 accept 会是两个 Decision。
   */
  private directEval(thread: Thread, trigger: Trigger, kind: AssessmentOutcome['kind'], ticketId?: string): Evaluation {
    const policy = this.policy()
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.now()
    if (thread.pending.includes(trigger.id)) { thread.pending = thread.pending.filter(id => id !== trigger.id); this.repo.threads.save(thread) }
    const id = key('eval', thread.key, 'direct', trigger.id, kind, ...ticketId ? [ticketId] : [], at)
    return { id, threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id,
      strength: gate.strength, actor: trigger.actor, basis: gate.basis, policyVersion: policy.version, startedAt: at, deadline: at }
  }
  /** 把结果应用到某个 Thread 的 Eval 上：进行中的那个，或仅走闸门的那个。 */
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    // 若 Policy 已变更但没有实时的 policyChanged 调用（例如跨升级或重启），则重新排队。
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: 'policyChanged' })
      return this.finish(thread, evaluation, { kind: 'unavailable', reason: [{ code: 'policyChanged' }], ...audit })
    }
    // 未经评估、直接从卡片上忽略的推断候选，会在给定原因旁注明这一点。
    const unassessed = outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit ? [{ code: 'ignoredFromCard' }] : []
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') return this.finish(thread, evaluation, { kind: outcome.kind,
      reason: [...unassessed, ...reasonOf(outcome.reason)], ...audit })
    if (outcome.kind === 'stop') {
      const ticket = this.repo.tickets.get(outcome.ticketId)
      if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, { kind: 'ignore', reason: [{ code: 'stopUnknown' }],
        ...audit })
      if (evaluation.strength !== 'explicit') return this.finish(thread, evaluation, { kind: 'ignore',
        reason: [{ code: 'stopNotExplicit' }], ...audit })
      const decision = this.finish(thread, evaluation, { kind: 'stop', reason: reasonOf(outcome.reason), ticketId: ticket.id, ...audit })
      this.tickets.end(ticket.id, 'human', 'stopped', this.now(), typeof outcome.reason === 'string' ? outcome.reason : undefined)
      return decision
    }
    return this.accept(thread, evaluation, outcome)
  }
  /** 以该 Eval 给出的 Mandate 记录一次 accept，并由 Tickets 创建对应 ticket。 */
  private accept(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Decision {
    const at = this.now()
    const basis = { ...evaluation.basis, ...(outcome.rules ? { rules: outcome.rules } : {}) }
    const { strength, policyVersion, actor } = evaluation
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: outcome.scope }
    const ticketId = key('ticket', evaluation.id)
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    const decision = this.finish(thread, evaluation, { kind: 'accept', reason: reasonOf(outcome.reason), ...audit, mandate, ticketId })
    this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at)
    return decision
  }
  /** 记录 Eval 的 Decision；Thread 自身的 Eval 随之结束，而仅走闸门的 Eval 不会影响 Thread 的 Eval。 */
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome)
    // 直接（仅走闸门）的评估不会清除 thread 当前活跃的评估。
    if (thread.evaluating?.id !== evaluation.id) return decision
    delete thread.evaluating; delete thread.expired
    this.repo.threads.save(thread)
    this.options.assessor.release?.(evaluation.id)
    return decision
  }
  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now()
    const decision: Decision = { id: key('decision', evaluation.id), evalId: evaluation.id, threadKey: thread.key, triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion, at, kind: outcome.kind, reason: outcome.reason, strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}), ...(outcome.mandate ? { mandate: outcome.mandate } : {}), ...(outcome.audit ? { audit: outcome.audit } : {}) }
    this.repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at }
      this.repo.triggers.saveDisposition(id, { ...disposition, evalId: evaluation.id, decisionId: decision.id })
    }
    this.emit('decision.recorded', { decisionId: decision.id, kind: decision.kind, threadKey: thread.key })
    return decision
  }
}

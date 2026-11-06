/**
 * 按 scope 划分的准入矩阵，把收到的消息归类为显式请求、推断候选或忽略。
 * 名单内的发送者只要明确对 agent 说话，就总是构成显式请求（不使用表格单元格）；未明确指向的消息不能是显式的。
 */
import type { AdmissionCell } from './core/model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = { listedUnaddressed: ['inferred', 'ignore'], unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'] } as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
/** 默认准入规则（与引入表格前的行为一致）：名单内发送者的未明确指向消息作为推断候选；名单外发送者忽略。 */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }

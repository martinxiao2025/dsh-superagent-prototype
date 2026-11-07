/**
 * 按范围划分的准入矩阵，将收到的消息分类为显式请求、推断候选或忽略。
 * 已列出的发件人只要点名 agent 就始终构成显式请求（表中没有对应单元格）；未被点名的消息不可能是显式请求。
 */
import type { AdmissionCell } from './core/model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = { listedUnaddressed: ['inferred', 'ignore'], unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'] } as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
/** 默认准入规则（与引入表格之前的行为一致）：已列出发件人的未点名消息视为推断候选；未列出发件人的消息一律忽略。 */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }

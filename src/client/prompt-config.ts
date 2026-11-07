/** 用于编辑提示词 section/skill 以及计算带折叠行差异的纯辅助函数。 */
import type { PromptConfig, PromptsView } from './api.ts'
import { valueLabel, type T } from './text.ts'

type TeamSection = PromptsView['sections'][number]
export type BuiltInPart = PromptsView['parts'][number]
export const isSkill = (name: string): name is `skill/${string}` => name.startsWith('skill/')
/** 内置 part，编辑器将其命名为 `part/<key>`，以区别于团队技能（`skill/<name>`）。 */
export const isPart = (name: string): name is `part/${string}` => name.startsWith('part/')
export const partKey = (name: `part/${string}`): string => name.slice(5)
export const sections = (config: PromptConfig): string[] => [...Object.keys(config).filter(name => name !== 'skills' && name !== 'overrides'),
  ...Object.keys(config.skills).map(name => `skill/${name}`), ...Object.keys(config.overrides ?? {}).map(key => `part/${key}`)]
/** 返回团队 section 或团队技能的文本、内置 part 的覆盖内容，团队未编写的则返回 `undefined`。 */
export const sectionText = (config: PromptConfig, name: string): string | undefined => isPart(name) ? config.overrides?.[partKey(name)]?.text
  : isSkill(name) ? config.skills[name.slice(6)]
  : name !== 'skills' && name !== 'overrides' && Object.hasOwn(config, name) ? config[name as TeamSection] : undefined
/**
 * 按编辑器所保存的形态呈现一份配置及其 overrides（none 以空 map 表示）：draft 与其迁往的版本随后逐条合并 override，
 * 因为主机存储“无 overrides”时用的是 none。传入 `parts` 时仅保留这些 part 的 overrides，因为
 * 从历史加载的版本可能覆盖了当前版本已不再包含的 part。
 */
export const withOverrides = (config: PromptConfig, parts?: readonly { key: string }[]): PromptConfig => ({ ...config,
  overrides: Object.fromEntries(Object.entries(config.overrides ?? {}).filter(([key]) => !parts || parts.some(part => part.key === key))) })
/** 内置 part 实际读取到的文本：团队的 override，否则为其内置文本。 */
export const partText = (config: PromptConfig, part: BuiltInPart): string => config.overrides?.[part.key]?.text ?? part.text
/**
 * 用 `text` 覆盖一个内置 part：override 会保留其编辑起点的那份内置文本——新建时或执行 `rebase` 时为当前版本，
 * 而当文本再次与内置文本相同时 override 随之移除。
 */
export function withOverride(config: PromptConfig, part: BuiltInPart, text: string | undefined, rebase = false): PromptConfig {
  const { [part.key]: previous, ...others } = config.overrides ?? {}
  const base = rebase ? part.base : previous?.base ?? part.base
  return { ...config, overrides: text === undefined || text === part.text ? others : { ...others, [part.key]: { text, base } } }
}
export function withSection(config: PromptConfig, name: string, text: string): PromptConfig {
  return isSkill(name) ? { ...config, skills: { ...config.skills, [name.slice(6)]: text } } : { ...config, [name]: text }
}
export function withoutSkill(config: PromptConfig, name: string): PromptConfig {
  const { [name.slice(6)]: _removed, ...skills } = config.skills
  return { ...config, skills }
}
/** draft 中与已保存版本不同的 section、技能与 override；重新定基（re-base）过的 override 也算作已变更。 */
export const changedSections = (config: PromptConfig, saved: PromptConfig): string[] =>
  [...new Set([...sections(config), ...sections(saved)])].filter(name => isPart(name)
    ? JSON.stringify(config.overrides?.[partKey(name)]) !== JSON.stringify(saved.overrides?.[partKey(name)])
    : sectionText(config, name) !== sectionText(saved, name))
export const sectionLabel = (t: T, view: Pick<PromptsView, 'skillPrefix'>, name: string): string =>
  isPart(name) ? valueLabel(t, 'promptPart', partKey(name)) : isSkill(name) ? `${view.skillPrefix}${name.slice(6)}` : valueLabel(t, 'promptPart', name)
export const skillNameFree = (name: string, config: PromptConfig, view: Pick<PromptsView, 'skillName' | 'builtin'>): boolean =>
  new RegExp(view.skillName).test(name) && !Object.hasOwn(config.skills, name) && !view.builtin.includes(name)
/** 将团队提示词 part 与其标题一起格式化（技能没有标题，因此省略）。 */
export const partWith = (part: { name: string; heading?: string | undefined }, base: string): string =>
  part.heading === undefined ? base : `${part.heading}\n${base}`

export type DiffLine = { kind: 'same' | 'del' | 'ins'; text: string } | { kind: 'fold'; count: number }
/** 计算行差异，把超过四行的连续未变更行折叠为其首尾行与一个计数。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n')
  // 从末尾开始填 LCS 表，使下方的前向遍历能按顺序重建差异。
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1
    : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: { kind: 'same' | 'del' | 'ins'; text: string }[] = []
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i]! }); i++; j++ }
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push({ kind: 'ins', text: b[j++]! })
    else lines.push({ kind: 'del', text: a[i++]! })
  }
  const folded: DiffLine[] = []
  for (let k = 0; k < lines.length;) {
    let end = k
    while (end < lines.length && lines[end]!.kind === 'same') end++
    if (end - k > 4) folded.push(lines[k]!, { kind: 'fold', count: end - k - 2 }, lines[end - 1]!)
    else folded.push(...lines.slice(k, Math.max(end, k + 1)))
    k = Math.max(end, k + 1)
  }
  return folded
}

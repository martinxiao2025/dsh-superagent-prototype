/** 供 IM 消息长度限制与模板使用的字数统计与字符串格式化工具。 */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** 统计中英文及混合文本中的类词片段数量，忽略标点。 */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** 校验出站 IM Markdown 消息不超过 `IM_WORDS`（链接文字与 URL 都计入上限）。 */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM 消息有 ${count} 个词，上限为 ${IM_WORDS} 个。请改写为简短的高层更新，不要拆成多条消息。`)
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** 用于 GitHub 登录名与仓库名的大小写不敏感比较。 */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

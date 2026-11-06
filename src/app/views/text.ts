/** 视图中纯文本预览与无 HTML 的 Markdown 所用的文本清洗与格式化辅助函数。 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
/** 去掉 HTML 注释与标签，解码常见实体，再清洗一次以捕获实体编码的标签。 */
const withoutHtml = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name]!)
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '')
export function plain(text: string, lines = false): string {
  const result = withoutHtml(text)
    .replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, lines ? '• ' : '').replace(/(\*\*|__|`)/g, '')
  return lines ? result.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : result.replace(/\s+/g, ' ').trim()
}
export const markdown = (text: string): string => withoutHtml(text).replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]').trim()
const scalar = (value: unknown): value is string | number | boolean | null => value === null || typeof value !== 'object'
function inline(value: unknown): string {
  if (scalar(value)) return value === null ? '' : String(value)
  return (Array.isArray(value) ? value : Object.values(value as object)).map(inline).filter(Boolean).join(Array.isArray(value) ? ', ' : ' · ')
}
function jsonLines(value: unknown): string[] {
  if (Array.isArray(value) && !value.every(scalar)) return value.map(item => `- ${inline(item)}`)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([name, item]) => scalar(item) || (Array.isArray(item) && item.every(scalar)) ? [`${name}: ${inline(item)}`]
      : [`${name}:`, ...jsonLines(item)])
  }
  return [inline(value)]
}
/** 把 JSON 载荷（或 `label: <JSON>` 形式的通知）格式化为键值行；非 JSON 文本原样返回。 */
export function readable(text: string): string {
  const match = /^(?:([^\n{[]{1,200}): )?(\{[\s\S]*\}|\[[\s\S]*\])$/.exec(text.trim())
  if (!match) return text
  try { return [...match[1] ? [match[1]] : [], ...jsonLines(JSON.parse(match[2]!))].join('\n') }
  catch (error) { void error /* 只是看起来像 JSON 的文本按原样展示。 */; return text }
}
export function preview(text: string, length = 160): string { return plain(readable(text)).slice(0, length) }
export const attribute = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

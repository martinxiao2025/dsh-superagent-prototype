/** 轻量解析器，用于报告与提问中使用的 Markdown 子集，并附带纯文本 URL 自动链接；从不解析原始 HTML。 */

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; url: string }
export type Block = { kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; ordered: boolean; items: string[] }

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch (error) { void error /* 结果并非 URL；按原样展示。 */; return url }
}
/** 将纯文本切分为文本节点与裸 URL 链接节点，并把句子末尾的标点排除在 URL 之外。 */
export function linkify(text: string): Inline[] {
  return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part): Inline => /^https?:\/\//.test(part)
    ? { kind: 'link', text: shortUrl(part), url: part } : { kind: 'text', text: part })
}
export function inlines(text: string): Inline[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/).flatMap((part): Inline[] => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return [{ kind: 'bold', text: part.slice(2, -2) }]
    if (/^`[^`]+`$/.test(part)) return [{ kind: 'code', text: part.slice(1, -1) }]
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    return link ? [{ kind: 'link', text: link[1]!, url: link[2]! }] : linkify(part)
  })
}
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let list: Extract<Block, { kind: 'list' }> | undefined
  for (const line of text.split('\n')) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (item) {
      const ordered = !/^\s*[-*]/.test(line)
      if (!list || list.ordered !== ordered) blocks.push(list = { kind: 'list', ordered, items: [] })
      list.items.push(item[1]!)
      continue
    }
    list = undefined
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (line.trim()) blocks.push(heading ? { kind: 'heading', text: heading[1]! } : { kind: 'paragraph', text: line })
  }
  return blocks
}

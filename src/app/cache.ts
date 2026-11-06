/**
 * 内存内 LRU 缓存，按 UTF-16 码元总量限额，并始终保留最近插入的条目。
 * Runtime 使用多个独立实例：为 `orchestrator_read` 缓存分页资源快照，为搜索与卡片缓存已解析的飞书消息链接。
 */
export class TextCache {
  private readonly texts = new Map<string, string>()
  private size = 0
  constructor(private readonly limit: number) {}
  get(key: string): string | undefined {
    const text = this.texts.get(key)
    if (text !== undefined) { this.texts.delete(key); this.texts.set(key, text) }
    return text
  }
  set(key: string, text: string): void {
    this.size -= this.texts.get(key)?.length ?? 0
    this.texts.delete(key)
    this.texts.set(key, text)
    this.size += text.length
    for (const [oldest, value] of this.texts) {
      if (this.size <= this.limit || oldest === key) break
      this.texts.delete(oldest)
      this.size -= value.length
    }
  }
  /** 条目按从最久未使用到最近使用的顺序排列。 */
  entries(): IterableIterator<[string, string]> { return this.texts.entries() }
}

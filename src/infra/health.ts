/** 组件健康登记表，显示在概览与 Source 状态面板中。 */
import type { Health } from '../sources/host.ts'

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** 从登记表上注销该条目（例如某个 Source kind 注销时）；后续的 `set` 调用变成空操作。 */
  release(): void
}

/**
 * 组件健康条目的中央登记表，对每个条目名称强制单一写入者所有权。
 * 由 Runtime、Effects、Sessions、DshExecutor、Settings 与 SourceRegistry 认领，由管理 HTTP 路由读取。
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.entries[name] = health },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
}

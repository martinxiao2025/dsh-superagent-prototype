/** 显示在概览与 source 状态面板中的组件健康注册表。 */
import type { Health } from '../sources/host.ts'

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** 从注册表注销该条目（例如 Source kind 注销时）；之后的 `set` 调用成为无操作。 */
  release(): void
}

/**
 * 组件健康条目的中心注册表，对每个条目名强制单一写入者所有权。
 * 由 Runtime、Effects、Sessions、HostExecutor、Settings 与 SourceRegistry 认领，并由管理 HTTP 路由读取。
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`健康条目 ${name} 已由其他部分报告`)
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

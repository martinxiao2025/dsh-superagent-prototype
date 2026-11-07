/** 基于编号快照与 Store KV 表中当前修订指针的版本化记录存储。 */
import type { Family, Key } from '../kv.ts'
import type { Store } from './store.ts'

/**
 * 在 `Store` 键值表中管理版本化记录的编号快照，并用一个指针键跟踪当前生效的修订版本。
 * 每次保存都会写入新快照并原子地推进指针，保留完整历史而不重复存储当前记录。
 * `Store` 用它保存设置历史，`Prompts` 用它保存版本化的提示词配置。
 */
export class Versions<V extends { revision: number }> {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly pointer: Key<number>,
    private readonly family: Family<V, [revision: number]>) {}
  /** 当前修订版本号，首次保存之前为 `0`。 */
  revision(): number { return this.store.get(this.pointer) ?? 0 }
  /** 当前快照，首次保存之前为 `undefined`。 */
  current(): V | undefined {
    const revision = this.store.get(this.pointer)
    return revision === undefined ? undefined : this.get(revision)
  }
  get(revision: number): V | undefined { return this.store.get(this.family(revision)) }
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      const version = make(this.revision() + 1)
      this.store.set(this.family(version.revision), version)
      this.store.set(this.pointer, version.revision)
      return version
    })
  }
  /** 存储快照但不推进当前修订指针（例如记录初始的内置基线）。 */
  keep(version: V): void { this.store.set(this.family(version.revision), version) }
  list(limit = Infinity): V[] {
    return this.store.keys(this.family).flatMap(name => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit)
  }
}

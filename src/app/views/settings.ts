/** 设置视图：汇总版本化配置块、按 Source 划分的表单与策略元数据，以及执行环境详情。 */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * 按配置块（`{ value, revision }`）、按 Source 的配置与需重启才生效的字段、执行环境详情来构建设置视图
 * （`stateDir` 提供默认工单工作目录的根路径）。
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.id] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]

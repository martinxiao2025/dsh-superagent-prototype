/** 主插件入口：挂载 Runtime，并为其提供部署账户变更时的重启回调。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent-cn'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // 管理面板自带设置界面，因此禁用 DSH 自动生成的设置页面。
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile 限制无需重启即可原地更新；账户变更则重启 dsh-superagent-cn。在 dsh-superagent-cn 重启期间，DSH 的设置服务会停止
  // 提供该入口，且只有在写入配置时才会重新读取它，因此要在重启后触发一次 `describe()`
  // 使已打开的配置表单无需刷新页面即可继续编辑。
  // TODO: 一旦 DSH 的设置服务会重新读取插件重新激活的入口，就去掉这次读取。
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent-cn restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent-cn ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent-cn is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

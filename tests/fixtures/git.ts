/** 测试所启动的 git 进程的环境。 */
import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * 带有 `extra` 的进程环境，并去掉那些告诉 git 该操作哪个仓库的变量（`GIT_LOCATION`）：
 * 测试运行在 `git rebase --exec` 内部，会继承 GIT_DIR，在那种环境下执行 `git init` 会重新初始化被测仓库。
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra })

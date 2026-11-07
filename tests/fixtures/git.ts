/** 测试所启动的 git 进程使用的环境。 */
import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * 在进程环境上附加 `extra`，并去掉那些告诉 git 要操作哪个仓库的变量（`GIT_LOCATION`）：
 * 测试运行在 `git rebase --exec` 内部时会继承 GIT_DIR，在那里执行 `git init` 会把被测仓库重新初始化。
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra })

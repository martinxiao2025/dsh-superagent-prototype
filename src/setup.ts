/** 结构化的启动与配置错误，并给出运维人员可以修复它们的设置位置。 */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'feishu'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} 不是由 dsh-superagent 写入的；请移动它，或另选一个状态目录。'],
  gitTooOld: ['deployment', 'git 不会读取 dsh-superagent 写入的 github.com 凭证配置；dsh-superagent 需要 git 2.32 或更高版本。'],
  environmentFailed: ['deployment', '准备 agent 环境失败。'],
  repositoryUnset: ['github', 'GitHub Source 没有指定仓库。'],
  agentCliUnset: ['github', '未设置 agent 的 GitHub CLI。'],
  agentCliMissing: ['github', '未找到 agent 的 GitHub CLI。'],
  agentCliSignedOut: ['github', 'agent 的 GitHub CLI 无法读取其账号。'],
  agentCliNoAccount: ['github', 'agent 的 GitHub CLI 没有返回 GitHub 账号。'],
  repositoryUnreadable: ['github', '@{account} 无法读取 {repository}。'],
  repositoryUnreported: ['github', 'agent 的 GitHub CLI 没有返回 {repository}。'],
  repositoryReadOnly: ['github', '@{account} 无法推送 {repository}。'],
  feishuCliFailed: ['feishu', '机器人 lark-cli 无法工作。'],
  feishuNoApp: ['feishu', '机器人 lark-cli 的 auth status 没有返回应用信息。'],
  feishuBotNotReady: ['feishu', '应用 {app} 的机器人身份状态为 {status}；请用 lark-cli 配置 app secret。'],
  feishuUserIdentity: ['feishu', '机器人 lark-cli 允许用户身份（strict mode 为 {mode}）；请按 docs/006-deployment.md 的说明，在 strict mode bot 下为机器人提供它自己的 lark-cli 配置。'],
  feishuNoBot: ['feishu', '飞书机器人 API 没有返回机器人的 open_id。'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * 当所需的 CLI、账号或仓库检查失败时，由部署与账号校验逻辑抛出。
 * `Setup` 会记录它供管理概览使用，HTTP 层则返回 `problem`，以便面板本地化显示。
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}

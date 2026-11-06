/** 把 GitHub issue、pull request、评论、review 与 CI 状态变化规范化为领域 Trigger。 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
/** GitHub 回复地址：issue/PR 对话；当 `url` 指向 discussion 评论时为 review thread。 */
export const githubChannel = (number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** 解析 `repository` 中 Issue、PR 或 review 评论的 web 或 API URL；其他 URL 或其他仓库返回 undefined。 */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub 把已注销账号返回为 `null`，并显示为 `ghost`。 */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * GitHub 评论或 review；review 带有 `state` 与 `commit_id`，行内 review 评论还带有其文件、
 * 行号、diff hunk 与 `in_reply_to_id`（其 review thread 的根评论 ID）。
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** `issues/<number>` 返回的 Issue；当该编号是 pull request 时，GitHub 会设置 `pull_request`。 */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * 当 GitHub 把该账号报告为普通用户（而非机器人或 GitHub App）时为 true。
 * 以普通用户账号运行的 review 机器人在这里算作人；哪些账号是自动化的由提示词识别。
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** 格式化行内 review 评论的 file:line 及其 diff hunk 的末尾几行（GitHub 的 hunk 在评论所在行结束）。 */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `对提交 ${comment.commit_id ?? '未知'} 的 ${comment.state} review` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** 为评论或 review 构建 trigger；无正文的评论或没有正文的 `COMMENTED` review 的文本为空。 */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? `github:${ref.number}`, String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * 为新开启 Issue 的标题与正文构建 trigger。
 * 其 ID 与以往存储 Issue 正文时相同，因此已存储的正文不会被再次摄入。
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * 为新开启 PR 的标题与描述构建 trigger。
 * 在 GitHub 中 PR 与 Issue 编号共用同一序列且不会冲突，因此这里沿用 `issueTrigger` 的 `github-issue` ID 形式。
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** 为默认分支 CI 状态变化构建 trigger；默认分支 CI 没有可回复的人，因此没有 `channel`。 */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('github-ci', String(pr.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}

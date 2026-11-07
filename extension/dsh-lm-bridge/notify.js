/**
 * 扩展主动通知的纯逻辑：不依赖 `vscode`，因此可以在普通 Node 测试里直接验证。
 *
 * 通知只针对“等待人工处理”的工单（面板总览里的 `person` 列表）。判定规则：
 * - 首次轮询只记录基线，不提醒，避免把历史积压当成新工作；
 * - 之后只有出现此前没见过的工单 id 才提醒一次；
 * - 工单离开 `person` 列表后从基线中移除，因此它再次等待处理时会重新提醒。
 */

/**
 * 比较两轮“等待人工处理”的工单，决定是否提醒。
 * @param {readonly string[] | undefined} previous 上一轮见过的工单 id；`undefined` 表示首次轮询。
 * @param {readonly {id: string, title?: string}[]} person 本轮等待人工处理的工单。
 * @returns {{ notify: boolean, ids: string[], fresh: { id: string, title?: string }[] }}
 *   `notify` 为真表示应弹一次提醒；`ids` 是下一轮的基线；`fresh` 是新增的工单。
 */
function decide(previous, person) {
  const ids = person.map(item => item.id)
  const known = new Set(previous ?? [])
  const fresh = person.filter(item => !known.has(item.id))
  return { notify: previous !== undefined && fresh.length > 0, ids, fresh }
}

/**
 * 生成提醒文案与按钮，供 `vscode.window.showInformationMessage` 使用。
 * @param {readonly {id: string, title?: string}[]} fresh 新增的等待人工处理的工单。
 * @returns {{ message: string, action: string }} 文案与唯一的按钮标题。
 */
function prompt(fresh) {
  const names = fresh.slice(0, 3).map(item => item.title && item.title.trim() !== '' ? item.title : item.id)
  const more = fresh.length > names.length ? ` 等 ${fresh.length} 个` : ''
  return { message: `dsh-superagent：${names.join('、')}${more} 等待你处理`, action: '打开面板' }
}

/**
 * 校验面板地址：只接受回环 http 地址，避免把工单标题发送到别的主机。
 * @param {string} value 配置里的面板地址。
 * @returns {string | undefined} 规范化的地址；不合法时为空。
 */
function loopbackUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return undefined
  return `${url.protocol}//${url.host}`
}

module.exports = { decide, prompt, loopbackUrl }

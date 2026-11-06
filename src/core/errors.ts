/** 面向用户的错误码，映射到其类别（'missing' 或 'refused'）与消息模板。 */
export const USER_ERRORS = {
  unknownTicket: ['missing', '未知工单'],
  unknownProblem: ['missing', '未找到不可用的 Eval'],
  unknownTrigger: ['missing', '未知 Trigger'],
  unknownAssignment: ['missing', '未知 Assignment'],
  unknownBlock: ['missing', '未知设置块：{block}'],
  unknownPromptRevision: ['missing', '未知提示词修订 {revision}'],
  unknownPromptPart: ['refused', '未知内置提示词片段 {part}'],
  ticketEnded: ['refused', '工单已结束'],
  assignmentEnded: ['refused', 'Assignment 已结束；该工单由更新的 Assignment 持有'],
  evalFinished: ['refused', 'Eval {eval} 已结束，或已被更晚的 Eval 取代；请判断该 Trigger 当前的 Eval'],
  notAdmissible: ['refused', 'Trigger 不可准入：{reason}'],
  notExplicit: ['refused', '通过 orchestrator_route 接受只适用于来自允许发送者的显式请求；请用 orchestrator_eval 与 orchestrator_eval_decide 评估主动候选'],
  ticketStopped: ['refused', '有人停止了这张工单；新的工作需要通过 orchestrator_route 接受'],
  mandateRevoked: ['refused', '当前 Policy 不再持有该工单的 mandate；新的工作需要通过 orchestrator_route 接受'],
  notRetryable: ['refused', '只有未结束的工单才能重试，且仅当它的 worker 最近一次汇报为 failed 或 blocked、此后没有人发过消息，或向它的 worker 交付 Input 失败时'],
  sourceThread: ['refused', '这是该工单起始所在的 Thread；它保持订阅'],
  followedThread: ['refused', '这个 Thread 属于该工单自己（例如它的 pull request）；它保持订阅'],
  notFollowing: ['refused', '该工单没有关注那个 Thread'],
  questionWithResult: ['refused', '问人的问题不能同时是就绪的结果或答案；请分开汇报'],
  askerWithoutQuestion: ['refused', '提出问题的那条消息必须带上它提出的问题'],
  notAsker: ['refused', '问题必须点名提出它的那条消息，且该消息须已到达这张工单'],
  notAnswerable: ['refused', '答案必须点名它所回答的问题，且该问题须已到达这张工单'],
  ackEnded: ['refused', '工单已结束；不要确认历史请求'],
  notReached: ['refused', 'Trigger 不属于这个 worker'],
  handedBack: ['refused', '该工单已经把那个 Trigger 交回了'],
  handedBackHere: ['refused', '该工单的 worker 已把那个 Trigger 作为超出其范围交回：把它当作新工作接受、挂接到另一张工单，或忽略它'],
  workerDecides: ['refused', '这条消息到达了它所在 Thread 上的工单 {tickets}：由该工单的 worker 决定它是否属于那里，并把不属于的交回，之后它会作为候选到达。只有 stop 通过 orchestrator_route，以 kind stop 执行'],
  ackNoChannel: ['refused', '确认需要有已指派的人类来源消息'],
  ackNotPerson: ['refused', '请使用原始的人类 Trigger，而不是机器人、CI 或 worker 的汇报'],
  notReady: ['refused', '工单尚未就绪，无法交付。把进展保持在内部，等待经过验证的 ready 汇报；不要把进展改标成答案，也不要通过其它渠道发送。'],
  notAttention: ['refused', 'Attention 需要该工单当前在 human_action 中的 attention 问题。常规的未完成工作保持在内部。'],
  notQuestion: ['refused', '答案必须针对原始的人类问题，而不是 worker 汇报或自动化 Trigger'],
  noAnswer: ['refused', '该人类 Trigger 还没有可用的 worker 答案。等待 worker 的汇报，或用 orchestrator_ticket_request_status 请求一次（它只作用于汇报了 waiting 的 worker）；常规进展不能改标成答案。'],
  noChannel: ['refused', '该工单或 Trigger 没有回复渠道'],
  panelOnlyEnvironment: ['refused', '执行环境（工单目录、prepare 命令、被禁止的命令）只能在管理面板中修改'],
  panelOnlyAccounts: ['refused', 'setup 会读取的 Source 字段（例如账号 CLI）只能在管理面板中修改'],
  setupComplete: ['refused', 'setup 已完成'],
  modelUnavailable: ['refused', '{block} 模型不可用：{error}'],
  promptTooLong: ['refused', '提示词配置超过 {limit} 个字符'],
  promptPlaceholders: ['refused', '“{part}”模板必须保留 {placeholders}，系统会填入它们'],
  promptPartEmpty: ['refused', '“{part}”片段不能为空；请重置它以沿用内置文本'],
  sourceNotInstalled: ['refused', '{source} 这个 Source 类型未安装'],
  noLabels: ['refused', '这个 Source 没有可刷新的名称'],
  nothingToSync: ['refused', '{source} Source 的 Policy 部分没有可同步的内容，或该 Source 已关闭、正在等待 setup'],
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>
export type UserErrorCode = keyof typeof USER_ERRORS

/**
 * 当调用方请求无效或引用了缺失状态时，由 Engine 各部分与应用服务抛出的结构化错误。
 * 工具处理器与 HTTP 路由通过检查其 code 与 missing 标志返回合适的状态响应，Web 面板则对 code 做本地化。
 */
export class UserError extends Error {
  readonly missing: boolean
  constructor(readonly code: UserErrorCode, readonly values: Record<string, string> = {}) {
    const [kind, text] = USER_ERRORS[code]
    super(text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match))
    this.missing = kind === 'missing'
  }
}

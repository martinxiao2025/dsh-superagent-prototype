orchestrator 决定候选：接受新工作、按显式的人为指示停止工单、把 Trigger 附加到已有工单，或忽略。
它还转达 worker 汇报。
orchestrator 在路由被接受的工作之前，使用有界的 Source 上下文与只读评估工具评估主动候选。
worker 负责实现调查、技术选择与验证。
在评估之外，orchestrator 不得检查代码、详细日志、链接文档或技术讨论，也不得自行解决 worker 的阻塞；把这些活动留给 worker。
路由并不授权改写请求：不要添加需求、实现计划、验收标准或重复的 Policy 清单。
worker 从原始 Source 与常驻 Policy 推导需求，而不是从路由器添加的指令。

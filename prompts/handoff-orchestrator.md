对活跃的 ticket.attention，用 orchestrator_reply purpose=attention 并带 ticket_id 及时投递其问题，即使执行器仍在工作。
把 attention.question 原样复制进 human_action；text 可以是简洁的转述。
不要等待阻塞报告，不要从普通进展编造问题，也不要重发未变化的请求。
没有结构化问题的 blocked 或 failed 报告不是 attention 请求。

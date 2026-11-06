对于活跃的 ticket.attention，即使 worker 仍在工作，也要通过 orchestrator_reply purpose=attention 并带上 ticket_id 及时投递其问题。
把 attention.question 原样复制到 human_action；text 可以是简洁的重新表述。
不要等待 blocked 汇报，不要从普通进度编造问题，也不要重发未变更的请求。
没有结构化问题的 blocked 或 failed 汇报不是 Attention 请求。

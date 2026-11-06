当工单负责人必须做决定时，使用 orchestrator_report human_action 并且只带一个具体问题；当某个具体的人的消息提出了它，例如一条审查评论要求某件事而你需要决定时，把那条消息的 Trigger ID 作为 question_for_trigger_id 传入，使问题在该人写下它的地方被提出，绝不在另一个 Source 中提出；在你继续无歧义的已授权工作时，state 可以保持为 progress。
不要只把问题写在 summary 里，或把它留在 GitHub 或本 Session 中等待。
省略 human_action 会保留待处理请求；human_action:null 或 ready 汇报会清除它。
重复同一个问题会复用其请求；不同的问题会以新请求替换它。
显式清除已解决的问题，而不是把后续进度当作它的解决。
把完整证据放在 summary 中，让 orchestrator 发送简短的问题。
未明确的视觉偏好不是重新设计的许可；将这类范围失败内部上报，不主动提澄清问题。

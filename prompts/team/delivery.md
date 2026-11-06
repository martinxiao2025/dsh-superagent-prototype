对于每个改动 UI 的工单，PR 描述必须同时包含 Before 与 After 的视觉证据，标注清晰，并指明基线与变更后的修订。
捕获相同的场景、视口、主题与相关 UI 状态，使对比有意义；截图或演示都可以。
只有 After 的证据是不完整的。
使用真实应用的截图，不要用冒充此前实现的示意图，也不要暴露飞书私密内容或凭证。
当后续 UI 改动使对比过时时，刷新该对比。
如果拿不到真实基线截图，就如实说明缺失的证据与限制，保持交接为不完整，不要声称该 UI PR 已就绪。
worker 负责捕获并验证该对比；orchestrator 在投递就绪结果前检查所上报的证据。

请求已匹配规则、Assignment、这些提示词或仓库指令所要求的审查。
绝不要以 agent 账号启用自动合并，使智能体不会合并自己的工作：只能用本节点名的 merge CLI 启用，即 `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`。
本节未点名 merge CLI 时，每个 PR 都由人来合并。
有 merge CLI 时，对于你从工单分支打开的 PR，在以下全部成立后为其 head commit 启用自动合并：该 PR 已就绪；变更行数少于 200 行（新增与删除合计）；那些指令要求的每个批准都覆盖该 commit；并且如果它改变了用户看到的内容，那些指令点名了谁批准此类改动且该批准覆盖该 commit。
不必等待批准即可报告就绪，并在批准到达时启用自动合并。
否则由人合并该 PR；在你的汇报中说明这一点。
一旦其中任一条件不再成立（例如某次审查要求修改），以及在你向该 PR 推送之前，用 `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` 撤回自动合并；当这些条件对新的 head 重新成立后再启用。
绝不要代替审查者批准或合并。
对每个审查你打开的 PR 的人进行署名，每个 PR 一次，署名在该 PR 分支的每个 commit 上：当人工审查者对它的反馈首次被评估时，重写该分支，使其每个 commit 为截至目前已署名的每个人各携带一个 `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer，其中 id 来自 `gh api users/<login> --jq .id`。
先按上述方式撤回自动合并。
运行 `git fetch origin`，用 `gh pr view <number> --json baseRefName` 得到的基分支设置 `base=$(git merge-base HEAD origin/<base branch>)`，并设置 `old=$(git rev-parse origin/<head branch>)`；然后运行 `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD`，每个被署名的人对应一个 `--trailer`，该操作只改动 commit 信息，并用 `git push --force-with-lease=<head branch>:$old` 推送；如果推送被拒绝，就停止并汇报。
你之后新增的 commit 携带相同的 trailer。
对某个 commit 的批准也覆盖其重写后的副本，因为二者的树相同。
如果该 PR 已合并，不要重写它；在 orchestrator_report 中记录未署名的审查者。
绝不要为了给审查者署名而推送空 commit。
不要给以下对象署名：机器人（登录名以 [bot] 结尾者与这些指令点名的审查机器人账号）、该 PR 的作者、agent 账号，以及这些指令点名的 commit 作者——后者已作为每个 commit 的作者被署名。
在 orchestrator_report 中记录你已署名的人，使后续 worker 不会再次署名。
如果有人在处理同一问题，且其分支或 PR 包含本工单的代码（来自工单分支的 commit，或搬运过去的改动），立即用 gh 关闭本工单的 PR，无需询问任何人，并在其上留一句点名该人的 PR。
仅仅相关、或并不包含本工单代码的工作，不是关闭的理由。
关闭该 PR 即结束该工单；不要再发其他消息。

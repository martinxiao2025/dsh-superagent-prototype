对每个改动 UI 的工单，PR 描述必须同时包含改动前与改动后的视觉证据，标注清晰，并指明基线与改动后的版本。
以相同的场景、视口、主题和相关 UI 状态截取，使对比有意义；截图或演示均可。
只有改动后证据是不完整的。
使用真实的应用截图，不要把示意图冒充先前实现；也不要暴露飞书私有内容或凭据。
后续 UI 变化使对比过时后就更新它。
如果无法取得真实的基线截图，如实说明缺失的证据与限制，保持交接未完成，不要声称该 UI PR 已就绪。
执行器负责截取并验证对比；主 Session 在交付就绪结果前检查所报告的证据。

请求匹配规则、任务指派、这些提示词或仓库指令所要求的评审。
绝不要以代理账号开启自动合并，这样代理就不会合并自己的工作：只用本节指名的合并 CLI 开启，形如 `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`。
本节未指名合并 CLI 时，每个 PR 都由人来合并。
有合并 CLI 时，对你从工单分支打开的 PR，在其头提交上开启自动合并，须同时满足：PR 已就绪；它改动少于 200 行（新增加删除）；相关指令要求的每个批准都覆盖该提交；并且如果它改变用户所见，相关指令指明了谁批准此类改动且该批准覆盖该提交。
上报 ready 时不等待批准，批准到达后再开启自动合并。
否则由人合并 PR；在你的报告中说明。
当上述任一条件不再成立时（例如评审要求更改），以及在向 PR 推送之前，立即用 `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` 撤回自动合并；新头满足条件后再开启。
绝不要代替评审者批准或合并。
对你打开的 PR，给每位评审过它的人记名，每个 PR 一次，落在 PR 分支的每个提交上：当一位人类评审者对它的反馈首次被评估时，重写分支，让每个提交按已记名人数各带一条 `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer，id 来自 `gh api users/<login> --jq .id`。
先按上述撤回自动合并。
运行 `git fetch origin`，用 `gh pr view <number> --json baseRefName` 得到基线分支并设 `base=$(git merge-base HEAD origin/<base branch>)`，设 `old=$(git rev-parse origin/<head branch>)`，然后运行 `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD`，每位被记名者一个 `--trailer`，它只改提交信息，再用 `git push --force-with-lease=<head branch>:$old` 推送；推送被拒绝就停下并上报。
之后新增的提交带同样的 trailer。
对一个提交的批准同样覆盖其重写副本，因为树相同。
如果 PR 已合并，不要重写它；在 orchestrator_report 记录未被记名的评审者。
绝不要为记名评审者推送空提交。
不要给以下对象记名：机器人（登录名以 [bot] 结尾的，以及这些指令指名为评审机器人的账号）、PR 作者、代理账号，或这些指令指名为提交作者的人——后者已作为每个提交的作者被记名。
在 orchestrator_report 记录你已记名的人，让后来的执行器不重复记名。
如果一个人正在解决同一问题，且其分支或 PR 包含本工单的代码（来自工单分支的提交，或其迁移的改动），立即用 gh 关闭本工单的 PR，不询问任何人，并在其上留一句指名那个人的 PR 的话。
只是相关、或不含本工单代码的工作，不构成关闭理由。
关闭 PR 即结束工单；不要再发任何消息。

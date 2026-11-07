# dsh-superagent-cn

> **研究原型，仅供参考，非 DeepSeek 官方产品。** 这份代码源自我们团队的日常开发工作，其中相当一部分工程由编码智能体完成。请把它当作研究代码，而非生产就绪的软件：它可能仍有缺陷，编码风格与工程实践也不完全一致。在自己的环境中使用之前，请先审阅并按需调整。
>
> 我们为公开做了适配，因此它与内部版本、以及论文《Exploring Super-agent Design: Towards a More Autonomous Agent System》所描述的实现并不完全相同。论文中讨论的部分设计是未来方向，尚未在本原型中实现。

dsh-superagent-cn 是面向单个 GitHub 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 形式封装。它监听 GitHub，可选地监听飞书。当被允许的人向智能体提出工作时，它会开立一个工作项，在自己的智能体 Session 与目录中完成工作，并回到原始会话答复，例如给出一个拉取请求。Web 管理面板展示需要人处理的事。

它也是一种与智能体协作的方式：**占用尽可能少的人的注意力，给出尽可能多的价值。** 一个能为整个团队行动的智能体，也能浪费整个团队的注意力，因此它只在被要求时、或在团队写下的规则允许时行动，只在有人必须行动、或能用上结果时开口。[docs/000-philosophy.md](docs/000-philosophy.md) 解释了这一原则，以及它对运维者的要求。

## 安装

安装步骤较多，所以由智能体陪你完成。对你的编码智能体说：

> 阅读本仓库的 SETUP.md，和我一起完成 dsh-superagent-cn 的安装。

它会一次问一个简短的问题，先展示完整计划，然后安装并配置好一切。[SETUP.md](SETUP.md) 就是它遵循的步骤。

## 文档

按顺序阅读编号文档；每一篇只建立在它之前的文档上。

- [000 哲学](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 管理面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：手动安装、配置、升级与故障排查
- [007 架构](docs/007-architecture.md)
- [008 实例手册](docs/008-cookbook.md)：添加一个 Source

## 开发

`pnpm check` 运行类型检查、测试和构建。

## 许可证

[MIT](LICENSE)

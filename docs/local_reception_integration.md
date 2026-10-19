# 本机接收前的组合源码

本项依据 #2 持续开发安排及 #7 的“先补现有候选组合和接收准备”推进。它将已经实现的 W1、W2/W3 和 W4/W5 放在一个可构建的源码目录，解决接手者需要自行拼接两条分支的问题。没有新增调度、生产接收或合并权，不以这一组合代替完整 G1/G2。

## 固定来源与真实依赖

组合分支 `feat/local-reception-integration` 的真实目标是 `feat/w2-docker-executor`，固定 B 为 `249a2a8b7818a86f966bc5dd9c9ee83bdb6dc68a`（PR19，执行代码为3028285，之后仅补两份验证文档）。另外纳入：

- W1 Mac 修补：`6c28ac7e944e8e3b6db79766bdd715bae66d2d60`（PR13）。
- W5 受控修复：`42c30c0e95d2d72195587b270c5b4466d4075c48`（PR18），其历史包含 W4 `e42f257` 和 W5 只读 `6993276`。
- PR19 的历史包含 W3 `cb7be791`、W2 `c73c0bf` 和原 W1 `6c6640e`。不会把 #14/#15 假定成 #16 自带的内容。

只在新组合分支组织这些固定源码，保留各原分支、旧审核和私人原件；不改旧 PR target，不合并 GitHub PR 或 main。源码合并与正式接收、用户接受、生产合入是不同事件。

## 本项可检查的完成条件

CI01 保存上述来源、实际分支关系和组合树。README/package 的入口冲突由负责人明确合成；CLI 同时保留 W1 自有临时目录规范化和 W2/W3 的已有入口。其余生产/测试代码须可追溯为固定父版本的原字节，不趁组合重构已有能力。

CI02 单目录构建通过；实际运行 Mac 适用的 W1/W3、Docker/W2 以及 W4 原结果/W5 回归。原 Linux/bubblewrap 专属测试单列为未在 Mac 运行，不跳过后冒充通过。宿主测试、Docker 子场景和真实固定候选容器测试分别记录。

CI03 新 Docker schema2 原件由组合后的 W3 实际读取；旧 schema1 原件仍可读。原件不改写，材料完整不自动成为独立接收或生产权限。

CI04 组合后的 W5 回读既有真实完成操作，核原会话、输入、最终结果、修复前后候选和测试/再审；不为证明组合而重复发送模型任务。原始捕获和封存记录不变；派生 result.json 允许按既有入口从封存终态重新生成，必须如实区分派生文件与原始记录。

CI05 对准确组合候选做独立有界复核：核冲突解决、受影响共享入口、来源可追溯及证据适用性。原分支 PASS 不无条件复制为组合 PASS。新增组合按独立 Draft PR 交付，保持原前置未合状态。

## 单目录入口

使用已有 Node24 与现成依赖，运行 `npm run build`。Mac 的 Docker 适用组合为 `npm run test:docker -- ABS_TRUSTED_EXECUTOR_CONFIG`；W4 原结果与 W5 回归为 `node --test dist/tests/w4/codex-results.test.js dist/tests/w5/*.test.js`。Docker 配置的准备和真实限制见 [Docker 验证入口](docker_verification.md)。`npm run test:mac` 另提供无需 Docker 的 Mac 适用组合；`npm test` 仍是原 Linux/bubblewrap 路线。

W1/W2/W3 使用 `node dist/src/cli.js`；原结果适配使用 `dist/src/codex-result-cli.js`；真实只读协作和受控示例修复分别使用 `dist/src/relay-cli.js`、`dist/src/repair-cli.js`。这些是同一源码目录里的不同已交付入口，queue 目前仍不自动调度 relay/repair。现有 JSON、模型报告或本地 shadow 控制不能授予远端写权。

## 后续前置

当前组合只收齐可用源码与接收前证据。W3 默认 shadow；独立接收入口、授权/身份来源、发布能力和生产写责任仍须按原 #5/#6 的具体子范围实现/验证。W5 写入链仍限定已采用的受管纯函数示例，不能称任意工程修复。W6 的双任务协调须在实际前置和窄范围条款成立后继续，界面随后接真实后台。等待远端合并与可独立开发分开处理，不因此新建主干写权或常驻模型循环。

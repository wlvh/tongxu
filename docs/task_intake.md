# 尚无 PR 的任务接入与负责人待办

对应 Issue #8 的 NT01–NT06 增量。开发任务现在可以在 PR 创建之前登记到原队列，保存目标、验收要求、可选 Issue 和真实 Git 工作区材料。没有借用 PR 编号，也没有生成虚构的 W1/W2 验证报告。

## 已实现的行为

- `DevelopmentTask` 固定仓库内任务标识、目标、范围、基线和选定文件。程序只读观察实际 HEAD、分支、树、共同祖先、HEAD 对象及原始文件内容；未提交文件同样具有内容摘要。Git 使用字面路径，直接读取不可变对象；工作文件用常规文件读取。观察版本 2 不调用可能执行仓库 clean/process 过滤器的工作树 status/diff，不执行测试、过滤器或网络获取。索引暂存状态不在观察范围，比较只表示原始字节相对 HEAD 的差异。只观察声明文件，未观察部分明确保持未知。
- 同一任务材料变化后追加一个原队列 packet。任务标识不变，旧 packet、运行、失败和输入原文保留。重读相同内容不创建新的执行预算。任务定义本身不可悄悄改写。
- 负责人待办使用原 events/blobs；实际发送继续使用原 `MessageRecords`、官方 CLI 执行器、完整角色提示、授权来源及资源消费者。没有另一套资源余额或通用消息服务。
- 一次 `work` 可以消费执行期间加入的待办，最多处理明确给定的 1–8 项。不同任务可以各自调查；同一任务原负责人存在活跃、未知或未解决发送时，后续责任交接等待原记录恢复。
- 后续任务使用新的原生上下文，并自动保留前次完整输入及报告。程序记录准确 run、角色、会话、当前 turn、实际送达和最终原文。这里没有恢复或接管外部 App 会话，也没有把导入的会话元数据当成控制权限。
- 跨任务联系必须引用同一范围内另一任务的实际捕获回复，且其材料仍当前。`contact` 按固定 A → B → A 模板进行三次角色处理；发送人来自程序核验的捕获，报告内容不选择下一工具、权限、问题或命令。
- 新发送前重新只读观察接收任务及所引用发送任务的工作区。固定计划与当前材料不一致时停止发送。历史回复仍可查看，但不变成当前材料的结论。
- 只允许显式撤销确认未发送、未占用资源、原启动已证明未开始的待办。未知执行和资源请求必须回到原消费者核实；不能删锁、换名字或撤销后重复调用模型。
- 工作台和秘书读取同一队列快照，显示“开发任务 · 尚无 PR”、负责人待办、历史材料、实际会话及完整协作报告。普通状态不暴露工作区路径、文件原文或报告正文。

## 本地入口

所有路径均使用绝对路径。运行前先构建，Node 版本要求沿用原项目。

```sh
node dist/src/task-cli.js enable --store /absolute/queue
node dist/src/task-cli.js add --store /absolute/queue --definition /absolute/task.json
node dist/src/task-cli.js enqueue --store /absolute/queue --request /absolute/request.json
node dist/src/task-cli.js prepare --store /absolute/queue --task TASK_SHA256 --id first
node dist/src/task-cli.js work --store /absolute/queue --task TASK_SHA256 --limit 4
node dist/src/task-cli.js status --store /absolute/queue --task TASK_SHA256
node dist/src/task-cli.js cancel --store /absolute/queue --task TASK_SHA256 --id old --source '明确撤销原未发送待办'
node dist/src/task-cli.js contact --store /absolute/queue --plan /absolute/contact.json
```

任务与请求的严格字段分别见 `src/task-contract.ts`、`src/task-inbox.ts`。`prepare` 给出固定 message plan/run，供既有逐动作授权或委托流程绑定；准备文件不授予权限。已配置 Owner/资源来源的队列继续要求原有授权与原有账本。资源绑定在原数据库事务内重查准入，与未发送撤销串行；开发任务不能绕过绑定直接申请资源。没有有效来源时只暂停相关调用。

`contact.json` 只含 `schemaVersion: 1`、`kind: "tongxu-task-owner-contact"` 和 `initial`、`contact`、`followup` 三个完整请求模板。三个模板的 `from` 都为 `null`；程序在前一角色实际返回后填入准确来源。初次与综合模板属于同一任务和同一负责人，联系模板属于另一任务。重复运行读取原捕获，不重复发起相同模型任务。

## 存储升级与边界

原观察版本 1 和失败证据保留供历史读取，新派发必须重新取得版本 2 的实际观察。

格式 15 在原表上增加明确的任务类型及操作限制。升级只在原队列没有活跃或未知 operation、claim、消息执行、整体审核或未核实发布时执行。旧客户端拒绝新格式；增加 Owner、资源或合并配置不会将格式降回旧版本。正式接收、修复和合并消费者不能把开发任务包当作 PR 验证包。

这里的负责人处理为只读调查和联系，不是通用功能开发执行器。实际 PR 的后续关联、受控实现任务、共享接口反馈到实现的阶段放行、五项人工控制、X1/X2、整体集成候选和全部 G1/G2 验收仍各有原定前置。来源摘要、进程退出、模型回复与产品验收分别记录。

## 验证

`tests/w6/task-intake.test.ts` 使用真实 Git 仓库、SQLite、实际子进程及明确标记的模型/授权/资源夹具，检查未提交内容、稳定任务身份、正在执行时的新待办、准确发送人、材料变化、重复入口、未知发送、未发送撤销、原授权/资源消费以及工作台/秘书一致性。夹具从不声称真实模型执行。真实模型捕获与独立审核另存私人证据目录，按准确候选记录。

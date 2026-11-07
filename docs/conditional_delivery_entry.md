# 已配置项目的条件交付入口

一个项目可能同时有生产者 A1、消费者 B1、等待二者结果的 A2，以及独立调查的 A3。安装者先登记这些任务、原负责人、依赖和可用能力。日常使用者选择动作后，程序从原队列推导准确版本、材料和已有操作，再调用各自的执行入口。相关公开范围依据 #9 中采用的 F12 编码前条款。[Issue #9](https://github.com/wlvh/tongxu/issues/9)

## 安装条件

安装者在仓库外提供一份 `tongxu-conditional-delivery-entry` 配置，固定项目仓库和目标分支、原队列、协调计划与只读执行能力。`integration` 登记原组合任务、顺序成员、进入组合的阶段、Git 对象、测试计划、独立接收模板和 GitHub 读取程序。文件引用包含规范绝对路径与内容摘要，日常动作复核实际文件。

原本人来源与委托、资源账本、模型程序、费用条件、隔离环境，以及独立发布程序分别按其正式入口配置。项目可登记最多两种额外协作安排，使用者从既有选项中选择。成员修复还需为相应任务登记 `repairs` 能力和 `postRepair` 测试及重组权限。完整配置结构由 `src/conditional-entry-contract.ts` 解析。

`ABS_ENTRY` 表示安装者提供的配置路径。以下命令从已构建的源码入口运行。一次动作返回之后，可用 `state` 查看当前条件，用 `report` 读取原报告。

```sh
npm run conditional-entry -- state --entry ABS_ENTRY
npm run conditional-entry -- prepare --entry ABS_ENTRY
npm run conditional-entry -- advice --entry ABS_ENTRY
npm run conditional-entry -- investigate --entry ABS_ENTRY
```

`prepare` 登记当前安排和原责任。`advice` 请提前参与的接收角色阅读相关契约并给出兼容、冲突或未知意见。`investigate` 让应当调查的任务实际读取材料，也让依赖任务消费已登记上游结果。每个阶段核自己所需的原产物和完整消费证据，A3 可独立推进。

## 从组合到独立接收

当 A1 和 B1 满足登记阶段的条件后，`integrate` 从准确的已验证成员构造私人组合候选。候选需要已有的远端 PR 关联，使用者提供该 PR 编号后，程序核对仓库、目标和实际 H/B，并保留原始读取。

```sh
npm run conditional-entry -- integrate --entry ABS_ENTRY
npm run conditional-entry -- collect --entry ABS_ENTRY --pr 99
npm run conditional-entry -- validate --entry ABS_ENTRY
npm run conditional-entry -- attach --entry ABS_ENTRY
npm run conditional-entry -- receive --entry ABS_ENTRY
npm run conditional-entry -- reuse --entry ABS_ENTRY --task B1
npm run conditional-entry -- investigate --entry ABS_ENTRY
```

这里的 99 是示意编号，实际使用准确 PR。`validate` 运行该新候选自己的隔离验证。`attach` 将原验证与本次实际观察关联。`receive` 让独立角色读取完整证据和协作安排。`reuse` 将准确的接收结果登记到 B1 声明的组合输出，后续调查负责实际消费。组合接收结论保留顺序成员，成员自己的接收结论单独记录。

同一代码候选的正文等材料更新后，显式 `collect` 会读取当前材料，原采集包和测试结果继续保存。成员材料由 `collect-member` 更新。随后 `refresh` 和 `integrate` 核准确成员、范围、测试与组合身份，将当前材料关联到原私人候选。再次 `attach`、`receive` 时，受影响的输入包含新的完整材料。接收结果和进度变化保留在完整上下文中，输入标识取相关任务和安排的语义内容。每个物理候选共用三批接收限额。

```sh
npm run conditional-entry -- refresh --entry ABS_ENTRY
npm run conditional-entry -- arrange --entry ABS_ENTRY --choice parallel
npm run conditional-entry -- report --entry ABS_ENTRY
```

`arrange` 的 `parallel` 必须是安装者已登记的选项。新安排继承原操作与原件，变化后所需的阅读和准入按当前事实处理。

## 处理原 RETURN

普通退回用 `repair --task TASK`。组合退回中针对某成员的发现，用 `repair-member --task TASK --finding INDEX` 选择原发现，程序从原生完整回复、绑定和成员证据推导修复请求。实现发生在已有授权的受管工作区。

```sh
npm run conditional-entry -- repair-member --entry ABS_ENTRY --task A1 --finding 0
npm run conditional-entry -- collect-member --entry ABS_ENTRY --task A1
npm run conditional-entry -- validate-member --entry ABS_ENTRY --task A1
npm run conditional-entry -- recompose-member --entry ABS_ENTRY --task A1
```

受管 H1 需要真实远端关联后才能采集。该成员的独立验证、重组的验证、组合新候选自己的验证与独立接收各自保留原证据。重组后沿上一节从 `integrate` 继续。原执行已经结束而回执待核时，用 `reconcile-repair`、`reconcile-member` 或 `reconcile` 查询相应原操作。

## 等待和证据范围

缺权限、资源、准确来源、已验证组合或完整回复时，动作返回具体原因。原运行的派发、进程、捕获或资源结果未知时，沿原请求核实。冷重开和报告读取保留完整原输入、输出、测试、原始远端读取及当前适用状态。

自动测试使用真实本机 Git、SQLite、子进程和配置好的本地 Docker。模型角色、GitHub、本人来源和资源提供者的受控样例按测试记录标明。生产模型的实际调用、独立发布与本人使用结果需要各自的真实证据。实现对应 `src/conditional-entry*.ts`、`src/candidate-validation*.ts`，测试入口见 [TESTING](../TESTING.md)。

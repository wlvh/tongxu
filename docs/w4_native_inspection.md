# 原生 Codex 隔离自检 CLI

这是 W4 首个软件子版：在无宿主认证、断网的新现场检查已安装 Codex 的元数据协议。它没有模型启动、秘书控制、Claude 接收或生产接管入口。支持本轮实测 Linux/bubblewrap；macOS、Windows 和其他 Codex 版本尚未验证。

## 运行

在本分支使用已有 Node 24+ 和依赖构建；无需安装或登录原生模型工具：

```bash
npm run build
node dist/src/native-cli.js inspect \
  --codex /absolute/path/to/existing/codex \
  --output /absolute/private/new-inspection
```

`--codex` 必须是操作者明确指定、真实规范路径下的普通可执行文件，不能是符号链接；`--output` 必须是仓库外尚不存在的绝对路径。拒绝覆盖旧输出、传入远端 endpoint 或控制模式。没有自动安装、更新、登录、费用或身份切换。运行失败保留缺口，不降级为宿主直接执行。

Linux bubblewrap 隔离网络/PID/挂载和环境，提供系统运行库、精确可执行文件及私有 passwd；临时 home/workspace 不挂宿主配置、认证、业务目录。私有 passwd 仅供原生 home 查找，不修改宿主 HOME/CODEX_HOME。系统 `/usr`、`/lib`、`/lib64` 作为只读运行资源，操作者应使用普通系统安装环境；本自检没有证明任意系统目录均不含人为放置的私密数据。

## 实际步骤和结果

先保存运行 ID/二进制 hash，然后在隔离内运行 `--version`、启动自己拥有的 stdio App Server。每次请求发出前保存 ID 与 `sent_or_unknown`，依次进行：

1. initialize / initialized；
2. 新 ephemeral thread，工作区固定 `/native-workspace`，read-only、never-approval；
3. 按准确返回 ID 读取元数据，`includeTurns=false`；
4. 对不存在的活动 turn 发出错误 expectedTurnId 的负向 steer；要求原生明确回复 `no active turn to steer`；
5. 再读同一 thread，确认原生仍报告 idle。

无 `turn/start`，也不会因为 steer 失败创建替身。只读 sandbox 本身不证明秘书无 shell；该控制能力保持 disabled。App Server 不主动结束时，仅终止本 CLI 新建的隔离进程，记录真实 SIGTERM/退出，不声称停止了任何外部任务。

退出码 0 表示上述自检完整，2 表示部分失败，1 表示参数/存储错误。输出仅含版本、运行 ID、二进制 hash、能力类别和缺口。`modelTurns=not_tested`、`authentication/cost=not_checked`、`independentReceiver=unavailable`、`productionActionAllowed=false` 始终保留；0 不代表模型可调用或完整 W4/G2 通过。

## 原始记录与中断

新目录为 0700，文件为 0600。`native-inspection.json` 保存运行、每个请求、能力、限制、退出与原件索引；`version.stdout/stderr`、`native.stdin/stdout/stderr` 保存原字节，`native-events.json` 便于逐条核查。版本子进程启动前建原件文件，输出块收到即落盘，合计限 128 KiB、15 秒；进程中断时已收到的版本/诊断原文仍留存。详细 session ID/消息只在私有包，不自动发布。App Server stdin 和 stdout/stderr 各限 4 MiB，单请求 15 秒；错 ID、重复晚到结果、坏 JSON、超时和断连不能完成其他请求。原生非零退出、尾部残帧、未实际返回 ephemeral 都留下缺口；意外工具或审批请求以错误拒绝并留下缺口。

进程被杀时，已有报告可能仍是 running，原请求为 sent_or_unknown；这表示未记录最终结果。不要把报告改成完成，不接管未知外部进程。此子版不支持 resume：先保留原目录，新自检必须另建目录，不能覆写旧证据。二进制前后 hash 不同或无法复核同样留下缺口。

## 验证及后续

```bash
npm test
npm run test:native
```

W4 协议夹具只证明客户端行为。真实验收记录见 [W4_NATIVE_INSPECTION](../verification/W4_NATIVE_INSPECTION.md)，最终 CLI 实际驱动已安装 Codex；临时探针和夹具未被算作双引擎验收。用户本机 Claude 环节见 [本机核实交接](local_claude_verification.md)。完整两轮、最终模型结果、受限角色工具、真实独立接收和 W5 自动审核循环仍有前置，不能据元数据可用直接放行。

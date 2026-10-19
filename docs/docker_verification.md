# 用现有 Docker 运行固定候选的检查

本入口让 Mac 使用已经运行的本地 Docker 执行 W2 测试。无需另建 Linux 虚拟机，也不在容器内再嵌套 bubblewrap。候选仍在隔离环境执行；旧 Linux/bubblewrap 入口与历史证据保留。

## 运行条件和计划

宿主需要 Node 24、Git 和已有 Docker CLI/本地 Unix socket。Docker 镜像由负责人事先准备并核对；运行器只接受本地完整镜像 ID，不拉取、不构建、不装依赖。镜像是可信工具链，需包含 `/usr/bin/env`、`/usr/bin/timeout`、`/usr/bin/git` 及明确指定的 Node；镜像 ID 固定字节，不等于它没有私人内容。镜像声明的自动卷不被接受，默认命令和健康检查不会运行。

Docker 计划和输出报告使用 schemaVersion 2；旧 bubblewrap 计划/报告仍为1。旧消费者会拒绝2，不能在忽略容器原件的情况下报告材料完整。新消费者同时读取两种格式，不将旧原件改写为新格式。Docker原件须独立满足非root/有界参数等固定约束，创建意图与前后观测一致，并与原计划的timeout绑定；不能用原件自己的声明替自己放行。不完整捕获与矛盾原件分别记录。

```json
{
  "schemaVersion": 2,
  "executor": {
    "kind": "docker",
    "client": "/usr/local/bin/docker",
    "endpoint": "unix:///absolute/existing/docker.sock",
    "image": "sha256:REPLACE_WITH_64_HEX_LOCAL_IMAGE_ID",
    "node": "/opt/node/bin/node"
  },
  "tools": [{
    "id": "project-check",
    "argv": ["/opt/node/bin/node", "check.cjs"],
    "timeoutMs": 30000,
    "expectedSampleIds": ["example"]
  }]
}
```

将占位值换成当前已安装程序、本地引擎和已有镜像的准确值。`argv` 是镜像内的绝对程序路径，工作目录固定 `/work`；不把 Mac Node 路径自动改写为 Linux 路径。可选 `dependencyDirectory` 沿用显式现成 `node_modules` 的只读挂载。没有结构化样本协议的项目检查省略 `expectedSampleIds`，比较覆盖保持未知。

```sh
node dist/src/cli.js verify --snapshot ABS_W1_BUNDLE --objects ABS_LOCAL_GIT --plan ABS_TRUSTED_PLAN --output ABS_NEW_PRIVATE_DIR
```

CLI 与固定 H/B/T 的规则沿用 [W2 文档](w2_verification.md)。计划由可信调用者提供，候选代码、Issue 或模型报告不能提供新的程序、网络入口或权限。容器仅见本阶段新 checkout、工具专属结果目录和所选只读依赖；原作者目录、个人 HOME、认证、Docker socket 不挂入。候选环境由固定入口清空；不继承宿主 token、代理或工具配置。

每个容器采用普通宿主 UID/GID、cap-drop ALL、no-new-privileges、Docker 内置默认 seccomp、默认系统路径屏蔽、独立 PID/IPC/cgroup、禁网络、只读根目录。容器自己的临时目录明确使用exec,nosuid,nodev，以便执行测试生成的普通helper；不放开宿主临时目录。固定上限为1GiB内存/无额外swap、128进程、2CPU、256MiB临时目录、16MiB HOME及共享内存；宿主绑定目录没有磁盘配额，不能称全面资源隔离。不会采用 privileged、unconfined 或 host 命名空间。执行器核实际容器配置，并用无宿主挂载的固定探针核内置过滤、非root及零能力权限；全局默认不同也不静默放宽。

## 原运行和中断核查

输出中的 `docker-runtime/` 保存工具链与探针；每个 `docker-tool-*` 保存创建意图、随机名、准确容器ID、命令、实际配置、原始 stdout/stderr 和终态。`verification.json` 的工具项给出该相对目录，并将完成的容器记录按 hash 纳入 raw 证据。Docker 客户端退出不等于任务结束；程序另读容器真实状态和退出码，超时/输出超限按准确ID终止，保存原件后回收容器。

核查入口需要显式给出原可信执行器配置 JSON（内容与计划的 `executor` 对象相同），不会执行原报告里临时替换的程序：

```sh
node dist/src/docker-recovery-cli.js inspect --execution ABS_ORIGINAL_DOCKER_TOOL_DIR --config ABS_TRUSTED_EXECUTOR_CONFIG
node dist/src/docker-recovery-cli.js stop --execution ABS_ORIGINAL_DOCKER_TOOL_DIR --config ABS_TRUSTED_EXECUTOR_CONFIG
```

`inspect` 只观察并另存记录；`stop` 必须先确认原控制器已结束，再停止准确的原容器，保留日志和真实状态，最后回收。活动/未知控制器、引擎或身份不符都拒绝控制。不删除旧证据、重新create/start、换镜像或重发任务。每个原操作使用本地 SQLite 事务互斥并发核查，进程退出自动释放事务锁，无需按超时删锁；不新建全机调度账本。

中断后的 Docker 日志受容量限制，只保存有界尾段。即使观察到容器退出0，缺失的原捕获也不会变成完整测试结果。原捕获与原 `verification.json` 保持原样；后续核查单独保存已结束、回收或仍未知的事实。重复核查能复用已保存的结束/回收证据，不再启动任务。此入口不自动执行原计划中尚未启动的阶段，也不把核查退出0当成原验证通过。

正常退出0表示请求的原件与执行完成；退出2保留失败/缺口；输入或存储错误退出1。恢复入口的0只表示该次核查/停止已完成。业务正确性、报告来源真实性、独立接收、用户接受与合并权限均不由这些状态授予。

## 验证入口

```sh
npm run test:docker -- ABS_TRUSTED_EXECUTOR_CONFIG
```

该入口使用真实 Docker，运行 W1、W2 通用语义、Docker 边界和 W3 消费者测试，自动规范化 Mac 临时目录。缺镜像/引擎会失败，不将用例跳过后计为通过。原 `npm test` 保留 Linux/bubblewrap 专属套件；两套执行结果分别记录。真实 tongxu 候选运行和独立审核记录见 [Docker 验证记录](../verification/W2_DOCKER_EXECUTOR.md)。

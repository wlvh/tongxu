# W2 本机 Docker 执行器验证记录

本增量在固定 PR15 `cb7be7910f1cb801521463948d5c1fc86bba6448` 上开发，真实 target 为 `feat/w3-shadow-reception`。原因是 W2 容器原件与 W3 消费规则需要同步，不能让旧消费者忽略新执行证据。没有改原 PR14/15 的目标或覆盖旧包；本分支不含 W4/W5 另一条源码分支。

范围来自原 #4 新增 DX01—DX06，发布并读回后实现。仅选择已有 Docker 的直接容器执行，不使用此前未获选择的 systempaths=unconfined 方案，不关闭隔离。旧 schema1/bubblewrap 保留，新 Docker 计划/报告使用schema2，旧消费者保守拒绝。

当前实际环境：Mac arm64、Node24.19.0，已有 Docker Desktop4.37.2/Engine27.4.0；复用原专用镜像 `sha256:5a237d8a6654658c78ea2ac03f5b65d4dd178f8d61141551d1fdaff217903ac2`，镜像内Node24.19.0/Git2.39.5。镜像按完整ID可读；本机按标签inspect曾失败，原失败记录保留，没有因此自动pull或替换镜像。实际引擎全局报告seccomp=unconfined，执行器显式选择builtin；真实子进程读取到Seccomp=2、NoNewPrivs=1、CapEff/CapBnd为0、UID501，无宿主挂载探针通过。

第一条代码探针因local日志驱动的压缩选项与max-file=1不兼容，容器未启动，State=created/StartedAt为零。已核原记录/准确ID后回收，原输出和原实现保存；添加compress=false后探针实际成功。没有删除失败或冒称原任务已执行。

当前增量已构建，实际Docker专项与W2语义15项通过；随后加入schema2、W3原件消费与恢复重复核查后，W1/W2-Docker/W3适用组合64/64、零跳过。覆盖实际Git树/HEAD、作者dirty保持、组合语义失败、改输入和Git状态拒绝、宿主文件/令牌/网络不可达、只读根/依赖、超时/输出上限终止准确容器；实际SIGKILL控制器后按原容器观察/停止/回收，重复核查无新任务，原verification和execution字节不变。原bubblewrap专属5项未在Mac伪装通过。

尚待本候选的真实tongxu固定PR smoke与新的独立审核。上述是作者当前代码的实际执行证据，不是整个G1/G2、生产接收、合并、用户接受或任意项目行为的保证。完整原件保留在本机独立运行目录；没有SEC或模型调用、新认证、费用、部署或远端合并。

# 同序｜人掌控目标，Agent 协作交付

**本分支是 v2.4 治理与产品体验候选，不是主干已采用或服务已上线。** main 的 v2.3 规范仍在 `docs/tongxu_v2_plan.md`。本次以独立分支／Draft PR 交付，不直推 main，不替本人批准，也不改 SEC_metrics。

## 阅读与采用

- [完整产品体验](docs/PRODUCT_GUIDE.md)：原秘书、协作、串并行、验收与恢复均保留，新增治理、判例、后果预览、模型回放和随机盲复审。
- [治理补充及官方核对依据](docs/GOVERNANCE.md)：本 PR 采用后与 v2.3 组成下一基线，未采用之前只是候选。
- [下一步发给 Codex](docs/CODEX_NEXT.md)；W0 原指令仍为 [CODEX_W0](docs/CODEX_W0.md)。
- [所有角色的装配入口](prompts/README.md)；没有新增常驻管理 Agent。
- [工作包增量发布清单](docs/issues/v24_work_package_delta.md)：采纳后嵌回原 #2—#9，不提前覆盖有效 Issue。

## 实际状态

2026-10-18 观测 main@1ba5ae893b49e5856a4e8d682139f70e5c907f5f 的 protected=false；连接器 protection 读取403，无管理写动作。本分支 CODEOWNERS **未在 base、未启用服务端强制**。真实身份与 main 治理启用见 #10，不能用文件存在冒称保护已经生效。

W0 继续只读基线、W1 Bridge、#3 草稿，在 Draft PR 停止；已有执行者接增量不重开。G1→G2→G3 不变，治理／模型评估不变成独立只读工作的前置。后续应用仍未实现。

## 离线 UI

```bash
python3 prototypes/build_product_ui.py
node verification/test_governance_v24.js
```

打开生成的 `prototypes/product_ui_prototype.html`。只是虚构数据演练，不连接模型、GitHub 或真实权限；不把生成器变成生产框架。完整限制见 [验证记录](verification/REVISION_V24.md)。T01—T52 保留，T53—T60 是新增未执行产品场景。

正式需求与交付仍在原 Issue／PR；Milestone 只分组，decisions.md 只索引可核验的采用，不建立第二份预算或授权。规则变更使用 base 上的有效规则审核，候选不能为自己解锁。

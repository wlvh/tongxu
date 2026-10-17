# 验证入口

当前设计/界面为 v2.2。先生成单文件，再运行离线行为断言：

```bash
python3 prototypes/build_product_ui.py
node verification/html_probes/current_v21.js
node verification/html_probes/current_v22.js
```

`current_v21.js` 保留旧36项行为；`current_v22.js` 新增39项。它们复用 DOM/计时替身，不连接真实服务。本轮实际执行范围和构建限制见 [REVISION_V22.md](REVISION_V22.md)。

旧 `html_probes/run.sh`、semantic_conflict 与 merge_tree 为历史复现/机制实验，旧 RESULTS.md 不是新版本通过报告。T01—T32 与 T33—T44 是待执行产品验收要求，原型测试不能将其改为通过。

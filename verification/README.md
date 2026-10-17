# 验证入口

## 当前产品原型 v2.1

```bash
python3 prototypes/build_product_ui.py
node verification/html_probes/current_v21.js
```

构建产物 `prototypes/product_ui_prototype.html` 可在浏览器打开，不提交。源码为构建器与冻结模板；不联网、不启动引擎。新脚本断言 36 个行为，临时目录自动清理；不能替代真实产品验收。完整范围和限制见 [REVISION_V21.md](REVISION_V21.md)。

## 历史反例与探针

```bash
bash verification/semantic_conflict/repro.sh
bash verification/merge_tree/test.sh
bash verification/html_probes/run.sh
```

这些入口保留以重演旧原型或 Git 反例。`html_probes/run.sh` 读取冻结产品模板，不把当前修复当旧缺陷，也不要求三套历史 HTML 同步改动。原 [RESULTS.md](RESULTS.md) 保留原执行环境、时点与范围；不是本轮重新完成的报告。

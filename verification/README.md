# 验证入口

当前v2.3覆盖与实际结果见 [REVISION_V23.md](REVISION_V23.md)。原始v1、v2、v2.1、v2.2记录保留为对应版本历史，不追写成当前生产通过。

正常克隆环境：
```bash
python3 prototypes/build_product_ui.py
node verification/html_probes/current_v22.js
node verification/html_probes/current_v23.js
```

历史v2.1回归入口 `node verification/html_probes/current_v21.js` 仍保留；本轮未重跑。`html_probes/run.sh`是历史故障重现，不是当前发布门。已有语义反例与merge-tree实验不撤销。

当前界面有固定演练输入与回执，没有真实模型、GitHub写入或生产凭据。T01—T52描述产品验收，离线逻辑断言、截图与prompt靜态检查不能将其改成已通过。默认全源构建与精确单文件输入构建的实测边界见当前记录。

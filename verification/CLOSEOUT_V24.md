# PR #11 有限修补与验证｜v2.4 不升级版本

基线：`ac910627645faa2d2b7c1193e20579cc3cafc9fc`。2026-10-18，本轮依据用户“修复 repo，并给出新的完整产品体验说明”在原 PR 分支修补，不直推 main、不合并、不自批。

## 修补范围

补齐 reviewer、receiver 和产品说明的 CODEOWNERS；分开 PR 路径约束与独立人工批准；澄清按认证而非工具名判身份；TX-DEC-001 写成面向未来、未生效的维护委托草案；限定首次安装记录；Codex 先推进 W0、治理核查并行。产品说明和治理页文案同步，不新增产品功能、版本或验收编号。公共治理 prompt 继续由现有装配加载，不增加常驻角色。

## 本轮实际验证

无法通过本容器 DNS 克隆 GitHub；仓库读取和发布使用连接器。已发布单文件的治理脚本、原测试及 harness 与固定候选 blob 完全一致，才用于本地重放。生成器也核对到原 blob，使用它已经支持的精确 v2.3 输入路径：

```bash
python3 prototypes/build_product_ui.py --base-v23 /path/to/exact-published-v23.html
node --check prototypes/governance_v24.js
node verification/test_governance_v24.js
python3 verification/check_closeout.py
```

v2.4 原有 **29 项离线行为断言通过**，没有修改原断言；新增 **16 项静态收尾检查通过**，只检查保护映射、草案状态、文档／prompt／UI 和 W0 入口一致性，不证明保护实际生效。

Chromium＋Playwright：以 set_content 内存载入，打开治理页，验证两步保护文案、TX-DEC-001 待采用、重复抽样使用原结果。1440×1000 桌面、390×844 手机；pageerror 为空，手机无横向溢出，实际截图已查看。只改文案，未重设布局或交互状态机。

未执行：联网新克隆的完整历史构建链、全部 v2.1／v2.2／v2.3 历史回归、原生 file:// 和持久存储、真实 GitHub 管理设置及拒绝路径、App 身份／工具权限、真实模型／通信／业务场景。原历史记录保留，不冒称这些测试在本 head 已完成。

## 交付含义

T01—T60 产品验收仍未执行。PR #11 仍 Draft；#10 管理配置未执行；TX-DEC-001 仍 proposed。本轮只为原候选补漏，不能把用户修复请求解释成采用全部长期权限。W0 按当前 main/#2 独立继续，交付基线、W1 Bridge、#3 草稿后停在 Draft PR。

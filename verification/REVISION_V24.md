# v2.4 候选验证与未完成项

日期：2026-10-18；受控输入 main@1ba5ae893b49e5856a4e8d682139f70e5c907f5f。

## 实际交付

治理补充、完整产品体验、CODEOWNERS 候选和 PR 模板、决定索引、角色公共治理指令与装配、工作包增量、Codex 下一步、T53—T60、治理页与具体变更预览。通过分支／Draft PR，不修改 main，不自动合并，不把候选正文发布成原 #2—#9 的有效命令。

创建 #10 跟踪真实身份与 main 治理启用。本轮 branches/main 观测 protected=false，rulesets 返回空列表，protection GET 返回403；没有管理写动作。CODEOWNERS 尚不在 base，未配置服务端保护。PR 作者若为 wlvh，不能由相同账号自批；初始化需独立身份／管理员动作，不能用绕过或直推补齐。

## 实际执行

本环境不能解析 github.com，读取和写入通过 GitHub 连接器；无完整网络克隆。基于精确已上传的 v2.3 HTML，SHA-256 为 d5dd927f291400fe43bee1811fdf4f6b95ab48f834244876cb51b630997b9023。

```
python3 prototypes/build_product_ui.py --base-v23 <exact-v2.3.html>
node --check <extracted-generated-script.js>
node verification/test_governance_v24.js
```

29 项断言通过，执行的是新生成完整脚本，覆盖预览不执行、当前确认、来源/只读拒绝、控制/授权/base变化后拒绝旧确认、重复确认拒绝、即时限制、恢复实施不恢复合并、后果未知、判例适用/撤销、固定抽样与去重、未执行不等于通过、治理证据不齐不变绿。DOM/计时/localStorage/身份为替身，不证明真实安全。为本轮在容器重建等价本地 harness；仓库继续使用保留的 harness2.js，未修改原文件。

Playwright + 系统 Chromium：原生 file:// 打开返回 ERR_BLOCKED_BY_ADMINISTRATOR，随后以 set_content 载入。实际点击组织方式→预览（状态仍 parallel）→确认（变 serial）→即时收回新合并→治理页→重复抽样（仍同一个选择且未执行）。1440×1050 桌面与390×844手机无页面错误；手机无水平溢出。已查看实际预览和治理截图。

未复跑全部 v2.1/v2.2/v2.3 回归、完整源文件默认构建链、原生 localStorage 持久化、完整键盘／主题验收、随机统计性质、真实模型回放、真实盲复审、GitHub保护／独立身份或生产停止竞态。已有回归入口保留，Codex 应在正常克隆中重跑，不因本29项通过宣称其他检查通过。

没有新增付费请求、SEC来源获取、业务测试或SEC_metrics写入。3—5历史哨兵和随机概率是后续有边界的设计，不是已建立数据集或采样授权。T01—T60 产品场景都仍未执行。

## 复现入口

正常克隆中默认 `python3 prototypes/build_product_ui.py` 从保留的 build_v23.py 及原来源构建；离线 fallback 校验精确源文件，不接受任意旧HTML。生成器仅作原型，不是生产框架。原#2 W0继续只读基线、W1 Bridge及#3草稿，Draft PR停止。

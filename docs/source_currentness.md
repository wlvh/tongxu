继续原 #3 的 W1 固定候选要求，补齐当前目标分支的直接观察。依据本次真实读取，#14/#16 的 PR REST 元数据 base.sha=6c6640e…，而同一 target feat/w1-readonly-cli 当前 Git ref=6c28ac7…。原包和旧B保留为历史证据，不回写旧件，也不修改任何远端分支。

固定实现前置 PR29 4203825dc30586b76a123efd9d5f918057c21d09；新分支 feat/w1-current-target-observation，真实 target feat/w3-composite-reception。前置如变更再按准确差异核对。

SC01 新采集从真实目标 ref 取得 B，与 PR 元数据报告的 base 分开保存，固定对象 diff/merge-base 使用观察到的实际 B。两者不同要明示来源差别，不把旧 API base 偷换进当前结果。
SC02 在采集结束前复读准确 target ref 与 PR H/target；ref 不可读、错误对象、目标改名、H/B变动都保留原件与缺口。缺少 ref 不能用旧base降级补成当前。
SC03 原固定包 resume 不改原H/B；目标前进时要求新目录保存新候选。旧快照没有直接ref证据时，仅保留历史范围，不据此回填今天的当前性。
SC04 只增加精确仓库、heads分支ref的GET白名单；不引入任意URL、其他Git对象API或写端点。脚本、私有来源及引用字符只作数据。保留分页/原材料/旧版本行为。
SC05 用安全故障样例验证静止PR元数据而真实base改变、前后ref竞态、权限/404/错误ref类型、resume不覆盖与非法路径；用新目录真实采集 #14/#16 读回H/B/target及原字节，不合并、不改target、认证或费用。

此补丁是接收事实基础的一处修正，不代表 G02 受管合入或所有 Issue 完成；原52项场景与其他自主待办继续保留。

实现补充：PR REST 报告的 base 与当前 ref 不同本身是明确来源差异，不通过改 target 处理。完整原 API 回复与两次 ref 原件均保留；固定 Git 和 W2 后续使用实际 B。成功结束的一次观察更新候选 observedAt 为末次 ref 读取时间，H/B/target 不变；失败或变动不刷新该时间。旧包重读可以新增观察，但不覆盖其固定候选和旧原件。

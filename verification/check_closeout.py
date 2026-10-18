#!/usr/bin/env python3
"""Narrow documentation/source checks; not an authorization or GitHub-settings verifier."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    owners = (ROOT / '.github/CODEOWNERS').read_text(encoding='utf-8')
    checks = []
    def check(condition: bool, name: str) -> None:
        if not condition:
            raise AssertionError(name)
        checks.append(name)
    entries = {line.split()[0]: line.split()[1:] for line in owners.splitlines()
               if line.strip() and not line.lstrip().startswith('#')}
    for name in ('/.github/', '/prompts/reviewer.md', '/prompts/receiver.md',
                 '/docs/PRODUCT_GUIDE.md', '/docs/decisions.md'):
        check(entries.get(name) == ['@wlvh'], 'candidate mapping: ' + name)
    decision = (ROOT / 'docs/decisions.md').read_text(encoding='utf-8')
    check('TX-DEC-001' in decision and '状态：proposed／待本人明确采用' in decision,
          'first maintenance delegation remains proposed')
    check('不因本文件或 PR #11 被合入就自动变成 adopted' in decision,
          'merge does not silently adopt maintenance delegation')
    governance = (ROOT / 'docs/GOVERNANCE.md').read_text(encoding='utf-8')
    check('第一步：PR 路径约束' in governance and '第二步：独立身份与边界批准' in governance,
          'two separate activation steps')
    check('此阶段不保证只有本人能合并' in governance,
          'PR-only limitation explicit')
    check('首次安装的限定采用记录' in governance and '不预先声称本人已经读过或批准' in governance,
          'bootstrap is not asserted as completed')
    instructions = (ROOT / 'docs/CODEX_NEXT.md').read_text(encoding='utf-8')
    check('主线：现在执行 W0' in instructions and '不等待 #11 合并' in instructions,
          'read-only W0 has no new governance prerequisite')
    check('不合并、不自动进入 W1' in instructions,
          'W0 retains explicit stopping point')
    ui = (ROOT / 'prototypes/governance_v24.js').read_text(encoding='utf-8')
    check('不能证明合并由本人执行' in ui and 'TX-DEC-001 为 proposed／待采用' in ui,
          'UI reflects protection and delegation limits')
    guide = (ROOT / 'docs/PRODUCT_GUIDE.md').read_text(encoding='utf-8')
    check(all(f'## {i}.' in guide for i in range(1, 15)),
          'full existing product journey retained')
    check('W0 的只读调查不等待它们' in guide,
          'product guide does not block W0')
    prompt = (ROOT / 'prompts/governance_contract.md').read_text(encoding='utf-8')
    check('TX-DEC-001 目前 proposed' in prompt and '普通 Issue 更新' in prompt,
          'shared role instructions preserve limited authority')
    print(json.dumps({'result': 'PASS', 'checks': len(checks), 'items': checks,
                      'scope': 'static closeout checks only; not server policy, human approval or application acceptance'},
                     ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()

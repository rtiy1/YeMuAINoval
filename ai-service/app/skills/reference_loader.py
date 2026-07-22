"""按需加载 Skill references。

从 SKILL.md 契约文本中提取被引用的 references 路径，安全读取对应文件，
按字节预算拼装后供执行器注入 LLM 上下文。
"""

import re
from dataclasses import dataclass

from app.skills.registry import SkillRegistryError, get_skill_registry


# 匹配反引号包裹的 references 相对路径，如 `references/xxx.md` 或 `references/xxx/yyy.md`
_BACKTICK_REF = re.compile(r'`((?:references/)[^\s`]+?\.(?:md|txt))`')
# 匹配裸路径，要求前面有「加载/见/参考/详见/按/查阅/读取」等动词引导
_BARE_REF = re.compile(
    r'(?:加载|见|参考|详见|按|查阅|读取|参考文件|参考文件见|见 references/|加载 references/)\s*'
    r'((?:references/)[^\s，。；：、）)】\]]+?\.(?:md|txt))',
    re.IGNORECASE,
)
# 兜底：行内出现的 references/xxx.md（不带反引号也未被动词引导），宽松匹配
_LOOSE_REF = re.compile(r'(?<![\w/])((?:references/)[^\s`，。；：、）)】\]\|]+?\.(?:md|txt))')


@dataclass(frozen=True)
class ReferenceLoadResult:
    """按需引用加载结果。"""
    references: dict[str, str]
    """{相对路径: 文件内容}，按 SKILL.md 中出现顺序排列。"""
    truncated: bool
    """是否因字节预算截断而跳过了部分文件。"""


def extract_reference_requests(instructions: str) -> list[str]:
    """从 SKILL.md 文本中提取被引用的 references 相对路径，去重保序。"""
    found: list[str] = []
    seen: set[str] = set()
    for pattern in (_BACKTICK_REF, _BARE_REF, _LOOSE_REF):
        for match in pattern.finditer(instructions):
            path = match.group(1).strip().strip('`').strip("'\"")
            # 规范化：统一正斜杠
            path = path.replace('\\', '/')
            if not path or path in seen:
                continue
            seen.add(path)
            found.append(path)
    return found


def load_referenced(
    skill_name: str,
    instructions: str,
    budget_bytes: int = 200_000,
) -> ReferenceLoadResult:
    """加载 SKILL.md 中引用的 references，按字节预算截断。

    Args:
        skill_name: skill 名称。
        instructions: SKILL.md 契约全文。
        budget_bytes: 累计字节预算，超过后跳过剩余文件。

    Returns:
        ReferenceLoadResult，含加载的 {路径: 内容} 和是否截断标记。
    """
    registry = get_skill_registry()
    requests = extract_reference_requests(instructions)
    loaded: dict[str, str] = {}
    accumulated = 0
    truncated = False
    for relative_path in requests:
        if accumulated >= budget_bytes:
            truncated = True
            break
        try:
            content = registry.read_reference(skill_name, relative_path)
        except (OSError, SkillRegistryError, UnicodeError):
            continue
        loaded[relative_path] = content
        accumulated += len(content.encode('utf-8'))
    return ReferenceLoadResult(references=loaded, truncated=truncated)


def format_references_block(references: dict[str, str]) -> str:
    """把加载的 references 格式化为可拼入 LLM system prompt 的文本块。"""
    if not references:
        return ''
    parts: list[str] = []
    for path, content in references.items():
        parts.append(f'### {path}\n{content}')
    return 'REFERENCES (按需加载，遵守其中规则):\n' + '\n\n---\n\n'.join(parts)

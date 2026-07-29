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
    available: int
    """SKILL.md 中声明的引用数量（未读取正文）。"""
    deferred: int
    """本轮未选择、留待后续任务按需加载的引用数量。"""


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


_MANDATORY_MARKERS = re.compile(r'写作前必须加载|写作前必读|执行前必须加载|全程必读|全程参考', re.IGNORECASE)
_ASCII_TERM = re.compile(r'[a-z0-9][a-z0-9_-]{1,}', re.IGNORECASE)
_CHINESE_RUN = re.compile(r'[\u4e00-\u9fff]{2,}')
_COMMON_BIGRAMS = {
    '写作', '正文', '章节', '故事', '小说', '用户', '当前', '参考', '加载',
    '文件', '内容', '进行', '使用', '需要', '根据', '相关', '完成',
}
_CONDITIONAL_REFERENCE_TRIGGERS = {
    'workflow-daily.md': re.compile(r'日更|续写|继续写|接着写'),
    'workflow-revision.md': re.compile(r'大修|回炉|重写|改写|修改第'),
    'artifact-protocols.md': re.compile(r'开书|大纲|卷纲|细纲|设定|世界观|人物|关系|追踪|伏笔|时间线'),
    'short-deslop.md': re.compile(r'去\s*ai|去味|自然化|模板腔', re.IGNORECASE),
    'opening-design.md': re.compile(r'开篇|开头|黄金三章|前\s*3\s*章|前三章'),
    'cross-book-recall.md': re.compile(r'对标|参考书|跨书|多本'),
}


def _terms(value: str) -> set[str]:
    text = str(value or '').lower()
    terms = {match.group(0) for match in _ASCII_TERM.finditer(text)}
    for match in _CHINESE_RUN.finditer(text):
        run = match.group(0)
        terms.update(
            run[index:index + 2]
            for index in range(len(run) - 1)
            if run[index:index + 2] not in _COMMON_BIGRAMS
        )
    return terms


def _mention_context(instructions: str, path: str) -> str:
    contexts: list[str] = []
    cursor = 0
    while len(contexts) < 8:
        index = instructions.find(path, cursor)
        if index < 0:
            break
        line_start = instructions.rfind('\n', 0, index) + 1
        line_end = instructions.find('\n', index + len(path))
        if line_end < 0:
            line_end = len(instructions)
        contexts.append(instructions[line_start:line_end])
        cursor = index + len(path)
    return '\n'.join(contexts)


def select_reference_requests(
    instructions: str,
    task_context: str = '',
    max_references: int = 8,
) -> list[str]:
    """只选择当前任务需要的 references，不读取任何 reference 正文。

    选择依据来自 SKILL.md 中引用附近的触发说明，以及用户指令/结构化任务上下文；
    未选中的引用保持延迟加载，不进入本轮模型提示。
    """
    requests = extract_reference_requests(instructions)
    if not requests or max_references <= 0:
        return []
    task_terms = _terms(task_context)
    ranked: list[tuple[int, int, bool, str]] = []
    for order, path in enumerate(requests):
        context = _mention_context(instructions, path)
        context_terms = _terms(f'{path}\n{context}')
        overlap = task_terms & context_terms
        score = min(len(overlap), 24) * 4
        score += sum(4 for term in overlap if term.isascii())
        mandatory = bool(_MANDATORY_MARKERS.search(context))
        trigger = next(
            (pattern for suffix, pattern in _CONDITIONAL_REFERENCE_TRIGGERS.items() if path.endswith(suffix)),
            None,
        )
        if trigger:
            if trigger.search(task_context):
                score += 40
            else:
                score = 0
                mandatory = False
        ranked.append((score, -order, mandatory, path))

    selected: list[str] = []
    # 无条件必读资料也限制为 2 份，避免大型 Skill 用“必读”重新造成全量注入。
    for _score, _order, _mandatory, path in sorted(
        (item for item in ranked if item[2]),
        reverse=True,
    )[:2]:
        selected.append(path)
    for score, _order, _mandatory, path in sorted(ranked, reverse=True):
        if len(selected) >= max_references:
            break
        if score <= 0 or path in selected:
            continue
        selected.append(path)
    return selected


def load_referenced(
    skill_name: str,
    instructions: str,
    budget_bytes: int = 200_000,
    task_context: str = '',
    max_references: int = 8,
) -> ReferenceLoadResult:
    """渐进加载当前任务选中的 references，按数量和字节预算截断。

    Args:
        skill_name: skill 名称。
        instructions: SKILL.md 契约全文。
        budget_bytes: 累计字节预算，超过后跳过剩余文件。
        task_context: 用户指令及本轮结构化上下文，用于匹配引用触发条件。
        max_references: 单轮最多读取的引用数量。

    Returns:
        ReferenceLoadResult，含加载的 {路径: 内容} 和是否截断标记。
    """
    registry = get_skill_registry()
    requests = extract_reference_requests(instructions)
    selected = select_reference_requests(instructions, task_context, max_references)
    loaded: dict[str, str] = {}
    accumulated = 0
    truncated = False
    for relative_path in selected:
        if accumulated >= budget_bytes:
            truncated = True
            break
        try:
            content = registry.read_reference(skill_name, relative_path)
        except (OSError, SkillRegistryError, UnicodeError):
            continue
        content_size = len(content.encode('utf-8'))
        if accumulated + content_size > budget_bytes:
            truncated = True
            break
        loaded[relative_path] = content
        accumulated += content_size
    return ReferenceLoadResult(
        references=loaded,
        truncated=truncated,
        available=len(requests),
        deferred=max(0, len(requests) - len(loaded)),
    )


def format_references_block(references: dict[str, str]) -> str:
    """把加载的 references 格式化为可拼入 LLM system prompt 的文本块。"""
    if not references:
        return ''
    parts: list[str] = []
    for path, content in references.items():
        parts.append(f'### {path}\n{content}')
    return 'REFERENCES (按需加载，遵守其中规则):\n' + '\n\n---\n\n'.join(parts)

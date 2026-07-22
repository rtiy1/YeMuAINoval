import re
from dataclasses import dataclass

from app.skills.registry import SkillRegistryError, get_skill_registry
from app.skills.script_checks import _compact, deduplicate_findings, run_check_scripts


RUBRIC_FILES = {
    'fanqie': 'rubrics/fanqie.md',
    'qidian': 'rubrics/qidian.md',
    'zhihu': 'rubrics/zhihu.md',
    'generic web-fiction': 'quality-rubric.md',
}
FALLBACK_RUBRIC = '''所有问题必须引用原文证据。主线、动机或规则崩坏为 S1；明显影响留存、节奏或可信度为 S2；局部质量问题为 S3；风格建议为 S4。无 S1/S2 可 APPROVE，有 S2 或大量 S3 为 CONCERNS，有 S1 为 REJECT。'''


@dataclass(frozen=True)
class ReviewResources:
    version: str
    rubric: str
    rubric_source: str
    instructions: str
    quality_rubric: str
    platform_rubric: str
    quality_checklist: str
    anti_ai_writing: str
    banned_words: str


def select_rubric(platform: str, genre: str = '') -> str:
    target = f'{platform} {genre}'.lower()
    if '番茄' in target or 'fanqie' in target:
        return 'fanqie'
    if '起点' in target or 'qidian' in target:
        return 'qidian'
    if '知乎' in target or '盐言' in target or 'zhihu' in target:
        return 'zhihu'
    return 'generic web-fiction'


def load_review_resources(rubric: str) -> ReviewResources:
    registry = get_skill_registry()
    package = registry.load('story-review')
    try:
        quality_rubric = registry.read_reference('story-review', 'quality-rubric.md')
        platform_rubric = registry.read_reference('story-review', RUBRIC_FILES[rubric])
        quality_checklist = registry.read_reference('story-review', 'quality-checklist.md')
        anti_ai_writing = registry.read_reference('story-review', 'anti-ai-writing.md')
        banned_words = registry.read_reference('story-review', 'banned-words.md')
        source = 'file'
    except (OSError, UnicodeError, SkillRegistryError):
        quality_rubric = FALLBACK_RUBRIC
        platform_rubric = FALLBACK_RUBRIC
        quality_checklist = FALLBACK_RUBRIC
        anti_ai_writing = FALLBACK_RUBRIC
        banned_words = FALLBACK_RUBRIC
        source = 'embedded fallback'
    return ReviewResources(
        version=package.version or 'unknown',
        rubric=rubric,
        rubric_source=source,
        instructions=package.instructions,
        quality_rubric=quality_rubric,
        platform_rubric=platform_rubric,
        quality_checklist=quality_checklist,
        anti_ai_writing=anti_ai_writing,
        banned_words=banned_words,
    )


def run_skill_checks(content: str, rubric: str) -> list[dict[str, str]]:
    findings = run_check_scripts('story-review', content)
    findings.extend(_banned_phrase_findings(content))
    findings.extend(_readability_findings(content))
    findings.extend(_platform_findings(content, rubric))
    return deduplicate_findings(findings)


def _banned_phrase_findings(content: str) -> list[dict[str, str]]:
    high_risk_terms = [
        '映入眼帘', '心中暗道', '深吸一口气', '嘴角勾起', '眼中闪过',
        '心头一震', '心下了然', '不容置疑', '不容置喙', '显而易见',
        '毫无疑问', '不可否认', '不由自主', '情不自禁', '取而代之的是',
    ]
    findings = []
    for term in high_risk_terms:
        match = re.search(re.escape(term), content)
        if not match:
            continue
        line_no = content.count('\n', 0, match.start()) + 1
        line = content.splitlines()[line_no - 1].strip()
        findings.append({
            'severity': 'S4',
            'category': 'prose',
            'location': f'第 {line_no} 行',
            'evidence': _compact(line),
            'issue': f'命中 story-review 一级高风险套语「{term}」。',
            'fix': '先判断它是否承担必要信息；不承担则删除，承担则改为角色当下的动作、物件或具体后果。',
        })
    return findings


def _readability_findings(content: str) -> list[dict[str, str]]:
    findings = []
    sentences = [item.strip() for item in re.split(r'[。！？!?]+', content) if item.strip()]
    long_sentence = next((item for item in sentences if len(re.sub(r'\s', '', item)) > 90), None)
    if long_sentence:
        findings.append({
            'severity': 'S3',
            'category': 'prose',
            'location': '长句所在段落',
            'evidence': _compact(long_sentence),
            'issue': '单句承载的信息和动作过多，手机阅读时可能失去换气点。',
            'fix': '只在动作、信息或情绪发生变化的位置断句，保持同一镜头连续。',
        })
    return findings


def _platform_findings(content: str, rubric: str) -> list[dict[str, str]]:
    paragraphs = [item.strip() for item in re.split(r'\n\s*\n', content) if item.strip()]
    if not paragraphs:
        return []
    first = paragraphs[0]
    if rubric == 'zhihu' and '我' not in content[:1000]:
        return [{
            'severity': 'S4',
            'category': 'platform',
            'location': '开篇前 1000 字',
            'evidence': _compact(first),
            'issue': '知乎盐言 rubric 默认偏好第一人称，当前开篇未见明确「我」视角。',
            'fix': '确认这是有意的多视角或第三人称设计；若不是，再统一为第一人称，不能只机械替换代词。',
        }]
    if rubric == 'fanqie':
        opening = '\n'.join(paragraphs[:3])
        action_or_conflict = re.search(r'[“「]|却|但是|突然|冲|抓|推|砸|逃|死|失踪|报警|威胁|拒绝|发现', opening)
        if len(opening) > 180 and not action_or_conflict:
            return [{
                'severity': 'S4',
                'category': 'platform',
                'location': '开篇前三段',
                'evidence': _compact(opening),
                'issue': '番茄 rubric 要求开篇尽快建立冲突、悬念或信息变化，当前前三段信号偏弱。',
                'fix': '人工确认开篇承诺；若确实偏平，把原文已有的风险、选择或异常信息前置，不新增无关事件。',
            }]
    return []

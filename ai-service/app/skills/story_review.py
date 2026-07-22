import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.skills.registry import SkillRegistryError, get_skill_registry


RUBRIC_FILES = {
    'fanqie': 'rubrics/fanqie.md',
    'qidian': 'rubrics/qidian.md',
    'zhihu': 'rubrics/zhihu.md',
    'generic web-fiction': 'quality-rubric.md',
}
FALLBACK_RUBRIC = '''所有问题必须引用原文证据。主线、动机或规则崩坏为 S1；明显影响留存、节奏或可信度为 S2；局部质量问题为 S3；风格建议为 S4。无 S1/S2 可 APPROVE，有 S2 或大量 S3 为 CONCERNS，有 S1 为 REJECT。'''
SEVERITY_ORDER = {'S1': 0, 'S2': 1, 'S3': 2, 'S4': 3}


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
    registry = get_skill_registry()
    settings = get_settings()
    lines = content.splitlines()
    findings: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix='story-review-') as temp_dir:
        input_path = Path(temp_dir) / 'chapter.txt'
        input_path.write_text(content, encoding='utf-8')
        punctuation = _run_script(
            settings.story_node_bin,
            registry.script_path('story-review', 'normalize-punctuation.js'),
            ['--check', str(input_path)],
            Path(temp_dir) / 'punctuation.out',
        )
        findings.extend(_punctuation_findings(punctuation, lines))
        ai_patterns = _run_script(
            settings.story_node_bin,
            registry.script_path('story-review', 'check-ai-patterns.js'),
            ['--check', '--json', '--fail-on=blocking', str(input_path)],
            Path(temp_dir) / 'ai-patterns.out',
        )
        findings.extend(_json_script_findings(ai_patterns, 'ai-patterns'))
        degeneration = _run_script(
            settings.story_node_bin,
            registry.script_path('story-review', 'check-degeneration.js'),
            ['--check', '--json', '--fail-on=blocking', str(input_path)],
            Path(temp_dir) / 'degeneration.out',
        )
        findings.extend(_json_script_findings(degeneration, 'degeneration'))
    findings.extend(_banned_phrase_findings(content))
    findings.extend(_readability_findings(content))
    findings.extend(_platform_findings(content, rubric))
    return deduplicate_findings(findings)


def _run_script(node_bin: str, script: Path, args: list[str], output_path: Path) -> str:
    with output_path.open('w+', encoding='utf-8') as output:
        completed = subprocess.run(
            [node_bin, str(script), *args],
            stdout=output,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            check=False,
        )
        output.flush()
        output.seek(0)
        stdout = output.read()
    if completed.returncode not in (0, 1):
        detail = completed.stderr.strip() or f'exit code {completed.returncode}'
        raise RuntimeError(f'{script.name} failed: {detail}')
    return stdout


def _punctuation_findings(output: str, lines: list[str]) -> list[dict[str, str]]:
    findings = []
    pattern = re.compile(r'^.+?:(\d+):(\d+): ([a-z-]+): (.+)$')
    for raw_line in output.splitlines():
        match = pattern.match(raw_line)
        if not match:
            continue
        line_no, column, finding_type, message = match.groups()
        source_line = lines[int(line_no) - 1].strip() if int(line_no) <= len(lines) else ''
        findings.append({
            'severity': 'S3',
            'category': 'format',
            'location': f'第 {line_no} 行，第 {column} 列',
            'evidence': _compact(source_line),
            'issue': f'标点或正文格式不符合 Skill 规范（{finding_type}）。',
            'fix': message,
        })
    return findings


def _json_script_findings(output: str, source: str) -> list[dict[str, str]]:
    if not output.strip():
        return []
    try:
        records = json.loads(output).get('findings', [])
    except json.JSONDecodeError as error:
        raise RuntimeError(f'{source} returned invalid JSON') from error
    findings = []
    for record in records:
        blocking = record.get('severity') == 'blocking'
        finding_type = str(record.get('type', 'unknown'))
        if source == 'degeneration':
            severity = 'S1' if blocking and finding_type in {'verbatim-repeat', 'truncated', 'placeholder-leak'} else ('S2' if blocking else 'S4')
        else:
            severity = 'S2' if blocking else 'S4'
        findings.append({
            'severity': severity,
            'category': 'format' if finding_type in {'em-dash', 'period-stutter', 'long-paragraph'} else 'prose',
            'location': f"第 {record.get('line', 1)} 行，第 {record.get('column', 1)} 列",
            'evidence': _compact(str(record.get('excerpt', ''))),
            'issue': str(record.get('message', finding_type)),
            'fix': _script_fix(finding_type, source),
        })
    return findings


def _script_fix(finding_type: str, source: str) -> str:
    fixes = {
        'truncated': '补完整个未结束的句子与章节收束，再重新审查。',
        'verbatim-repeat': '删除无功能的复读，只保留承担情绪或信息作用的一处。',
        'placeholder-leak': '移除模型拒绝语、占位符或元信息，补回实际正文。',
        'meta-leak': '改成角色在场景中可感知的事件、物件或相对时间。',
        'trailer-ending': '删掉预告式总结，让结尾停在具体动作、画面或台词上。',
        'abstract-summary-tic': '保留必要信息，删除作者总结，把后果落回角色当下。',
        'long-paragraph': '按镜头、动作或信息变化检查断段，功能完整的长段可保留。',
    }
    return fixes.get(finding_type, '按原文语境处理该处；保留剧情功能，不做机械同义词替换。' if source == 'ai-patterns' else '修复该处退化痕迹后重新运行检查。')


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


def deduplicate_findings(findings: list[dict[str, str]]) -> list[dict[str, str]]:
    unique: dict[tuple[str, str, str], dict[str, str]] = {}
    for finding in findings:
        key = (finding['category'], finding['location'], finding['evidence'])
        existing = unique.get(key)
        if not existing or SEVERITY_ORDER[finding['severity']] < SEVERITY_ORDER[existing['severity']]:
            unique[key] = finding
    format_by_line: dict[str, dict[str, str]] = {}
    output: list[dict[str, str]] = []
    for finding in unique.values():
        if finding['category'] != 'format':
            output.append(finding)
            continue
        line_key = finding['location'].split('，', 1)[0]
        existing = format_by_line.get(line_key)
        if not existing or SEVERITY_ORDER[finding['severity']] < SEVERITY_ORDER[existing['severity']]:
            format_by_line[line_key] = finding
    output.extend(format_by_line.values())
    return sorted(output, key=lambda item: (SEVERITY_ORDER[item['severity']], item['location']))[:40]


def _compact(text: str, limit: int = 120) -> str:
    normalized = re.sub(r'\s+', ' ', text).strip()
    return normalized if len(normalized) <= limit else f'{normalized[:limit - 3]}...'

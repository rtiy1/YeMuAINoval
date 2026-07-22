"""共享的 Node 脚本检查 helper。

从 story_review.py 提取的脚本执行基础设施，供 story-review 和 story-deslop 共用。
三个确定性脚本（normalize-punctuation / check-ai-patterns / check-degeneration）
在多个 skill 中完全相同，统一调用入口。
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path

from app.config import get_settings
from app.skills.registry import SkillRegistryError, get_skill_registry


SEVERITY_ORDER = {'S1': 0, 'S2': 1, 'S3': 2, 'S4': 3}

# 三个确定性脚本，所有写作/审查/去味 skill 共用同一份
CHECK_SCRIPTS = (
    'normalize-punctuation.js',
    'check-ai-patterns.js',
    'check-degeneration.js',
)


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


def run_check_scripts(skill_name: str, content: str) -> list[dict[str, str]]:
    """对正文运行该 skill 的确定性检查脚本，返回 findings 列表。

    自动从该 skill 的 scripts/ 目录查找脚本（需 registry 允许）；
    脚本缺失时跳过该项检查而非硬失败，便于 skill 只携带部分脚本时降级。
    """
    registry = get_skill_registry()
    settings = get_settings()
    lines = content.splitlines()
    findings: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix=f'story-{skill_name}-') as temp_dir:
        input_path = Path(temp_dir) / 'chapter.txt'
        input_path.write_text(content, encoding='utf-8')
        for script_name in CHECK_SCRIPTS:
            try:
                script = registry.script_path(skill_name, script_name)
            except SkillRegistryError:
                continue
            if script_name == 'normalize-punctuation.js':
                stdout = _run_script(
                    settings.story_node_bin, script,
                    ['--check', str(input_path)],
                    Path(temp_dir) / 'punctuation.out',
                )
                findings.extend(_punctuation_findings(stdout, lines))
            else:
                stdout = _run_script(
                    settings.story_node_bin, script,
                    ['--check', '--json', '--fail-on=blocking', str(input_path)],
                    Path(temp_dir) / f'{script_name}.out',
                )
                findings.extend(_json_script_findings(stdout, script_name.replace('.js', '')))
    return findings


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
        if source == 'check-degeneration':
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
    return fixes.get(finding_type, '按原文语境处理该处；保留剧情功能，不做机械同义词替换。' if source == 'check-ai-patterns' else '修复该处退化痕迹后重新运行检查。')


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

"""story-deslop 执行器：确定性检查 + LLM 改写。

与 story-review 共享同一套确定性脚本（已验证完全相同），但语义不同：
deslop 的目标是「按检查结果改写正文」而非「只报告问题」。
"""

import json
import logging
from typing import Any

from app.agent_instructions import DATA_BOUNDARY_POLICY, NIGHT_RAIN_IDENTITY, STORY_FACT_POLICY
from app.config import get_settings
from app.model_content import model_content_text
from app.skills.capability import SkillInvocation
from app.skills.model_helper import create_chat_model, has_api_key, resolve_context_window, truncate_for_context
from app.skills.reference_loader import format_references_block, load_referenced
from app.skills.registry import get_skill_registry
from app.skills.script_checks import deduplicate_findings, run_check_scripts


logger = logging.getLogger(__name__)

REFERENCE_BUDGET_BYTES = 150_000


def execute_deslop_skill(invocation: SkillInvocation) -> dict[str, Any]:
    settings = get_settings()
    package = get_skill_registry().load('story-deslop')
    override = invocation.model_config_override

    # 按需加载引用
    ref_result = load_referenced('story-deslop', package.instructions, REFERENCE_BUDGET_BYTES)
    references_loaded = sorted(ref_result.references.keys())
    references_block = format_references_block(ref_result.references)

    # 从 payload 取正文；缺正文时只做诊断
    content = invocation.payload.get('content') or ''
    content = content.strip() if isinstance(content, str) else ''

    # 运行确定性检查（story-deslop 自带同一份脚本）
    checks: list[dict[str, str]] = []
    if content:
        try:
            raw_findings = run_check_scripts('story-deslop', content)
            checks = deduplicate_findings(raw_findings)
        except Exception:
            logger.exception('story-deslop deterministic checks failed')
            checks = []

    if not has_api_key(override, settings):
        return {
            'status': 'needs_model',
            'skill': 'story-deslop',
            'execution_scope': 'deslop',
            'contract_loaded': True,
            'references_loaded': references_loaded,
            'references_truncated': ref_result.truncated,
            'checks': checks,
            'message': '该 Skill 已加载契约、引用与确定性检查；改写正文需要配置 API Key。',
        }

    if not content:
        return {
            'status': 'needs_input',
            'skill': 'story-deslop',
            'execution_scope': 'deslop',
            'contract_loaded': True,
            'references_loaded': references_loaded,
            'checks': [],
            'message': '请提供需要去 AI 味的正文（payload.content）。',
        }

    context_window = resolve_context_window(override, settings)
    model = create_chat_model(override, settings, default_temperature=0.3)

    checks_summary = json.dumps(checks, ensure_ascii=False, default=str)[:20_000] if checks else '确定性检查未发现问题'
    system_parts = [
        NIGHT_RAIN_IDENTITY,
        f'\n\n{STORY_FACT_POLICY}',
        f'\n\n{DATA_BOUNDARY_POLICY}',
        '\n\n你正在执行 story-deslop Skill。把 AI 味浓重的网文文本改写自然，降低模板化、书面腔和过度工整感。保留剧情功能，只改“怎么说”不改“说什么”。完成全部正文后直接输出完整改写稿，不要输出解释、检查报告、隐藏推理或元信息。',
        f'\n\nSKILL CONTRACT:\n{truncate_for_context(package.instructions, context_window, override.max_tokens if override else None, 120_000)}',
    ]
    if references_block:
        system_parts.append(f'\n\n{truncate_for_context(references_block, context_window, override.max_tokens if override else None, 150_000)}')
    system_prompt = ''.join(system_parts)

    human_parts = [
        f'用户指令：{invocation.instruction or "对以下正文去 AI 味"}',
        f'\n\n确定性检查结果（供改写参考，不要在输出中复述）：\n{checks_summary}',
        f'\n\n待改写正文：\n{content[:120_000]}',
    ]

    try:
        response = model.invoke([
            ('system', system_prompt),
            ('human', ''.join(human_parts)),
        ])
    except Exception:
        logger.exception('story-deslop LLM rewrite failed')
        return {
            'status': 'failed',
            'skill': 'story-deslop',
            'execution_scope': 'deslop',
            'references_loaded': references_loaded,
            'checks': checks,
            'message': '模型执行失败，请检查模型地址、密钥和上下文长度。',
        }

    return {
        'status': 'completed',
        'skill': 'story-deslop',
        'execution_scope': 'deslop',
        'references_loaded': references_loaded,
        'references_truncated': ref_result.truncated,
        'checks': checks,
        'output': model_content_text(response.content),
        'original': content,
    }

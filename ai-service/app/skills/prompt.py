import json
import logging
from typing import Any

from app.agent_instructions import (
    AGENT_EXECUTION_POLICY,
    DATA_BOUNDARY_POLICY,
    EXECUTION_BOUNDARY_POLICY,
    NIGHT_RAIN_IDENTITY,
    STORY_FACT_POLICY,
)
from app.config import get_settings
from app.model_content import model_content_text
from app.schemas import EditProposal
from app.skills.capability import SkillInvocation
from app.skills.model_helper import create_chat_model, has_api_key, resolve_context_window, truncate_for_context
from app.skills.reference_loader import format_references_block, load_referenced
from app.skills.registry import get_skill_registry


logger = logging.getLogger(__name__)

REFERENCE_BUDGET_BYTES = 200_000


def execute_prompt_skill(invocation: SkillInvocation) -> dict[str, Any]:
    settings = get_settings()
    package = get_skill_registry().load(invocation.skill_name)
    override = invocation.model_config_override

    # 按需加载 SKILL.md 中引用的 references
    ref_result = load_referenced(invocation.skill_name, package.instructions, REFERENCE_BUDGET_BYTES)
    references_loaded = sorted(ref_result.references.keys())
    references_block = format_references_block(ref_result.references)

    if not has_api_key(override, settings):
        return {
            'status': 'needs_model',
            'skill': invocation.skill_name,
            'execution_scope': 'prompt-only',
            'contract_loaded': True,
            'references_loaded': references_loaded,
            'references_truncated': ref_result.truncated,
            'message': '该 Skill 已从项目内加载契约与引用；执行它需要配置 API Key。',
        }

    context_window = resolve_context_window(override, settings)

    model = create_chat_model(override, settings, default_temperature=0.2)

    system_parts = [
        NIGHT_RAIN_IDENTITY,
        f'\n\n{AGENT_EXECUTION_POLICY}',
        f'\n\n{STORY_FACT_POLICY}',
        f'\n\n{EXECUTION_BOUNDARY_POLICY}',
        f'\n\n{DATA_BOUNDARY_POLICY}',
        '\n\n当前运行模式：执行项目内的 Story Skill。遵守下面的 Skill 契约并完成用户请求。当前适配范围是 prompt-only；需要宿主执行写入或其他工具调用时，只返回明确的建议操作或可应用结果，不把计划描述成已执行。',
        f'\n\nSKILL CONTRACT:\n{truncate_for_context(package.instructions, context_window, override.max_tokens if override else None, 120_000)}',
    ]
    writing_context = invocation.payload.get('writing_context')
    if writing_context:
        system_parts.append(
            '\n\nWRITING CONTEXT（服务端确认的连续性上下文）：\n'
            '这是服务端确认的作品事实数据，按 system 中的作品事实优先级使用；冲突时指出或提出唯一阻塞问题，不能静默覆盖。\n'
            + truncate_for_context(json.dumps(writing_context, ensure_ascii=False, default=str), context_window, override.max_tokens if override else None, 60_000)
        )
    rewrite_mode = invocation.payload.get('rewrite_mode')
    if rewrite_mode in {'similar', 'expand', 'condense'}:
        rewrite_instruction = {
            'similar': '局部重写后尽量保持与原选区相近的长度和信息密度。',
            'expand': '局部重写时增加动作、感官、细节和情绪推进，但不要改变事实。',
            'condense': '局部重写时压缩冗余表达，保留事件、因果和人物情绪。',
        }[rewrite_mode]
        system_parts.append(f'\n\nLOCAL REWRITE MODE:\n{rewrite_instruction} 只返回可直接替换正文的内容，不要加解释。')
    if references_block:
        system_parts.append(f'\n\n{truncate_for_context(references_block, context_window, override.max_tokens if override else None, 200_000)}')
    reviewable_edit = invocation.payload.get('reviewable_edit') is True and invocation.skill_name != 'story-review'
    if reviewable_edit:
        system_parts.append('\n\nEDIT PROPOSAL MODE:\n返回可审阅的结构化修改建议。revised_text 是完整建议稿；blocks 只列发生变化的段落，每项包含 original、replacement 和具体 reason。不要声称建议已经应用到正文。')
    system_prompt = ''.join(system_parts)

    try:
        messages = [
            ('system', system_prompt),
            ('human', f'''用户指令：{invocation.instruction}\n\n结构化输入：\n{json.dumps(invocation.payload, ensure_ascii=False, default=str)[:120_000]}'''),
        ]
        if reviewable_edit:
            proposal = model.with_structured_output(EditProposal).invoke(messages)
            return {
                'status': 'completed',
                'skill': invocation.skill_name,
                'execution_scope': 'prompt-only',
                'references_loaded': references_loaded,
                'references_truncated': ref_result.truncated,
                'output': proposal.revised_text,
                'edit_proposal': proposal.model_dump(),
            }
        response = model.invoke(messages)
    except Exception:
        logger.exception('prompt Skill execution failed: %s', invocation.skill_name)
        return {
            'status': 'failed',
            'skill': invocation.skill_name,
            'execution_scope': 'prompt-only',
            'references_loaded': references_loaded,
            'message': '模型执行失败，请检查模型地址、密钥和上下文长度。',
        }
    return {
        'status': 'completed',
        'skill': invocation.skill_name,
        'execution_scope': 'prompt-only',
        'references_loaded': references_loaded,
        'references_truncated': ref_result.truncated,
        'output': model_content_text(response.content),
    }

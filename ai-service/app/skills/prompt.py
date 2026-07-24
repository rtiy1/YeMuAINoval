import json
import logging
from typing import Any

from app.config import get_settings
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

    model_kwargs = {
        'model': (override.model if override and override.model else None) or settings.openai_model,
        'api_key': (override.api_key if override and override.api_key else None) or settings.openai_api_key,
        'temperature': override.temperature if override and override.temperature is not None else 0.2,
    }
    if override and override.api_base_url:
        model_kwargs['base_url'] = override.api_base_url
    elif settings.openai_base_url:
        model_kwargs['base_url'] = settings.openai_base_url
    if override and override.max_tokens:
        model_kwargs['max_tokens'] = int(override.max_tokens)

    from langchain_openai import ChatOpenAI
    model = ChatOpenAI(**model_kwargs)

    system_parts = [
        '你正在执行项目内的 Story Skill。遵守下面的 Skill 契约，只完成用户请求，不声称执行了当前环境没有提供的浏览器、图片、文件写入或外部网络能力。当前适配范围是 prompt-only：需要落盘或工具调用时，输出清晰的下一步结构化计划。',
        f'\n\nSKILL CONTRACT:\n{truncate_for_context(package.instructions, context_window, override.max_tokens if override else None, 120_000)}',
    ]
    writing_context = invocation.payload.get('writing_context')
    if writing_context:
        system_parts.append(
            '\n\nWRITING CONTEXT（服务端确认的连续性上下文）：\n'
            '事实优先级：用户本轮明确要求 > 已确认的 canon_fact/world_rule/character_state 与项目设定 > 当前章节正文和大纲 > 其他记忆、素材与未回收伏笔 > 最近对话 > 一般创作知识。'
            '冲突时必须指出或提问，不能静默覆盖；未知信息不得补成既定事实。分析报告只能描述为建议，不得声称已修改正文。\n'
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
        'output': response.content,
    }

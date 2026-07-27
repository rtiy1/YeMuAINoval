import json
import logging

from app.agent_instructions import (
    DATA_BOUNDARY_POLICY,
    EXECUTION_BOUNDARY_POLICY,
    NIGHT_RAIN_IDENTITY,
    STORY_FACT_POLICY,
    compose_system_prompt,
)
from app.config import get_settings
from app.schemas import WritingProposal, WritingProposalRequest, WritingProposalResponse
from app.skills.model_helper import create_chat_model, has_api_key, resolve_context_window, truncate_for_context
from app.skills.reference_loader import format_references_block, load_referenced
from app.skills.registry import get_skill_registry


logger = logging.getLogger(__name__)


def generate_writing_proposal(request: WritingProposalRequest) -> WritingProposalResponse:
    requirements = request.requirements
    selected_skill = 'story-short-write' if requirements.type == '短篇' else 'story-long-write'
    settings = get_settings()
    override = request.model_config_override
    if not has_api_key(override, settings):
        return WritingProposalResponse(
            status='needs_model',
            phase='collecting_requirements',
            reply='创作需求已经保存。请先在设置中配置模型，再继续生成建书方案。',
            selected_skill=selected_skill,
        )

    package = get_skill_registry().load(selected_skill)
    reference_context = (
        f'生成建书方案\n'
        f'{json.dumps(requirements.model_dump(), ensure_ascii=False)}\n'
        + '\n'.join(f'{item.role}: {item.text}' for item in request.messages[-8:])
    )
    references = load_referenced(
        selected_skill,
        package.instructions,
        70_000,
        task_context=reference_context,
        max_references=5,
    )
    context_window = resolve_context_window(override, settings)
    contract = truncate_for_context(package.instructions, context_window, override.max_tokens if override else None, 80_000)
    reference_block = truncate_for_context(
        format_references_block(references.references),
        context_window,
        override.max_tokens if override else None,
        120_000,
    )
    transcript = '\n'.join(f'{item.role}: {item.text}' for item in request.messages[-20:])
    system_prompt = compose_system_prompt(
        NIGHT_RAIN_IDENTITY,
        STORY_FACT_POLICY,
        EXECUTION_BOUNDARY_POLICY,
        DATA_BOUNDARY_POLICY,
        f'''你正在执行 {selected_skill}，根据已确认的创作需求生成可直接创建作品的结构化方案。

必须遵守：
1. type 必须是“{requirements.type}”，genre 和 style 保持用户选择，不擅自替换。
2. tone 写清主角、目标、阻碍和核心冲突。
3. 只生成章节大纲，不生成章节正文；至少 3 章，短篇最多 12 章，长篇首批最多 10 章。
4. 每章 content 必须说明本章推进、冲突和结尾钩子。
5. 不声称已经创建文件或写入作品。

SKILL CONTRACT:
{contract}

{reference_block}''',
    )
    human_prompt = f'''已确认需求：
{json.dumps(requirements.model_dump(), ensure_ascii=False)}

最近对话：
{transcript or '无'}

请生成建书方案。'''

    try:
        model = create_chat_model(override, settings, default_temperature=0.4).with_structured_output(WritingProposal)
        proposal = model.invoke([('system', system_prompt), ('human', human_prompt)])
        proposal.type = requirements.type
        proposal.genre = requirements.genre
        proposal.style = requirements.style
        chapter_limit = 12 if requirements.type == '短篇' else 10
        proposal.chapters = proposal.chapters[:chapter_limit]
        return WritingProposalResponse(
            status='completed',
            phase='awaiting_confirmation',
            reply=f'我已经按“{requirements.genre} · {requirements.style}”整理好建书方案，请确认后创建。',
            selected_skill=selected_skill,
            proposal=proposal,
        )
    except Exception:
        logger.exception('writing assistant proposal generation failed')
        return WritingProposalResponse(
            status='failed',
            phase='collecting_requirements',
            reply='方案生成失败，请检查模型地址、密钥和上下文长度后重试。',
            selected_skill=selected_skill,
        )

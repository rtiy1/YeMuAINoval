import json
import logging

from app.agent_instructions import DATA_BOUNDARY_POLICY, STORY_FACT_POLICY, compose_system_prompt
from app.config import get_settings
from app.schemas import StoryMemoryExtractRequest, StoryMemoryExtractResponse
from app.skills.model_helper import create_chat_model, has_api_key, resolve_context_window, truncate_for_context


logger = logging.getLogger(__name__)

MEMORY_SYSTEM_PROMPT = compose_system_prompt(
    STORY_FACT_POLICY,
    DATA_BOUNDARY_POLICY,
    '''你是夜雨的作品记忆整理模块。阅读当前章节和可信作品上下文，只提取对后续连续性有长期价值的候选记忆。

允许类型：
- character_state：角色当前目标、关系、伤势、持有物、已知信息等可变化状态
- event：正文中已经发生且会影响后续的事件
- world_rule：世界运行规则、能力限制、社会制度
- chapter_summary：本章简明事实摘要
- canon_fact：不得违背的身份、时间、地点、因果等事实
- voice_habit：角色稳定的说话方式、称呼与禁忌

规则：
1. 只提取正文明确成立的事实，不推测、不补设定。
2. 已有记忆优先；若新内容与其冲突，使用 replaces_memory_id 指向需要更新的记录并在 reason 说明依据，不能静默覆盖。
3. 不重复现有记忆，不把临时氛围或泛泛文学评价当作事实。
4. 每项给出简短理由，供作者确认；你只生成候选项，不声称已经写入作品。
5. 至少生成一条 chapter_summary，除非正文无法形成有效摘要。
6. 输出必须符合 StoryMemoryExtractResponse schema，不展示隐藏推理。''',
)


def extract_story_memories(request: StoryMemoryExtractRequest) -> StoryMemoryExtractResponse:
    settings = get_settings()
    override = request.model_config_override
    if not has_api_key(override, settings):
        return StoryMemoryExtractResponse(status='needs_model', message='整理作品记忆需要先配置模型。')

    context_window = resolve_context_window(override, settings)
    context = truncate_for_context(
        json.dumps(request.writing_context, ensure_ascii=False, default=str),
        context_window,
        override.max_tokens if override else None,
        60_000,
    )
    content = truncate_for_context(
        request.content,
        context_window,
        override.max_tokens if override else None,
        120_000,
    )
    human_prompt = f'''章节：{request.chapter_title}

可信作品上下文：
{context or '无'}

当前章节正文：
{content}

整理需要作者确认的候选记忆。'''
    try:
        model = create_chat_model(override, settings, default_temperature=0.1).with_structured_output(StoryMemoryExtractResponse)
        response = model.invoke([('system', MEMORY_SYSTEM_PROMPT), ('human', human_prompt)])
        response.status = 'completed'
        response.message = response.message or f'已整理 {len(response.candidates)} 条候选记忆，尚未写入作品。'
        return response
    except Exception:
        logger.exception('story memory extraction failed')
        return StoryMemoryExtractResponse(status='failed', message='作品记忆整理失败，请检查模型配置和上下文长度。')

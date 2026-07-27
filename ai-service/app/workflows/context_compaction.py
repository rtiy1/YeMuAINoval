import json
import logging

from app.agent_instructions import DATA_BOUNDARY_POLICY, STORY_FACT_POLICY, compose_system_prompt
from app.config import get_settings
from app.model_content import model_content_text
from app.schemas import ContextCompactRequest, ContextCompactResponse
from app.skills.model_helper import create_chat_model, has_api_key, resolve_context_window, truncate_for_context


logger = logging.getLogger(__name__)

CONTEXT_COMPACTION_PROMPT = compose_system_prompt(
    STORY_FACT_POLICY,
    DATA_BOUNDARY_POLICY,
    '''你是夜雨的长篇写作上下文压缩模块。把较早的对话压缩成一份可持续更新的滚动摘要，供后续创作继续使用。

必须保留：
1. 作者已经明确提出的创作目标、禁忌、文风和修改偏好。
2. 已经确认的剧情事实、人物状态、因果、时间线、世界规则和伏笔。
3. 尚未完成的任务、未解决的问题和作者仍在等待的结果。
4. 对后续章节有约束力的修改结论。

删除重复、寒暄、工具过程、临时状态和已经失效的尝试。已有摘要与新消息冲突时，以新消息中更明确、更晚的事实为准，并简短记录变化。只输出压缩摘要，不展示隐藏推理。''',
)


def compact_story_context(request: ContextCompactRequest) -> ContextCompactResponse:
    settings = get_settings()
    override = request.model_config_override
    if not has_api_key(override, settings):
        return ContextCompactResponse(
            status='needs_model',
            message='上下文压缩需要先配置模型。',
            compacted_messages=0,
        )

    context_window = resolve_context_window(override, settings)
    payload = {
        'existing_summary': request.existing_summary,
        'messages': [message.model_dump() for message in request.messages],
    }
    source = truncate_for_context(
        json.dumps(payload, ensure_ascii=False, default=str),
        context_window,
        override.max_tokens if override else None,
        160_000,
    )
    try:
        response = create_chat_model(override, settings, default_temperature=0.1).invoke([
            ('system', CONTEXT_COMPACTION_PROMPT),
            ('human', f'请更新滚动摘要：\n\n{source}'),
        ])
        summary = model_content_text(response.content).strip()
        if not summary:
            return ContextCompactResponse(status='failed', message='模型未返回上下文摘要。')
        return ContextCompactResponse(
            status='completed',
            message=f'已压缩 {len(request.messages)} 条历史消息。',
            summary=summary[:30000],
            compacted_messages=len(request.messages),
        )
    except Exception:
        logger.exception('context compaction failed')
        return ContextCompactResponse(status='failed', message='上下文压缩失败，本次继续保留原始历史。')

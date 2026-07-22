import json
import logging
from typing import Any

from langchain_openai import ChatOpenAI

from app.config import get_settings
from app.skills.capability import SkillInvocation
from app.skills.registry import get_skill_registry


logger = logging.getLogger(__name__)


def execute_prompt_skill(invocation: SkillInvocation) -> dict[str, Any]:
    settings = get_settings()
    package = get_skill_registry().load(invocation.skill_name)
    if not settings.openai_api_key:
        return {
            'status': 'needs_model',
            'skill': invocation.skill_name,
            'execution_scope': 'prompt-only',
            'contract_loaded': True,
            'message': '该 Skill 已从项目内加载；执行它需要配置 OPENAI_API_KEY。',
        }
    model_kwargs = {
        'model': settings.openai_model,
        'api_key': settings.openai_api_key,
        'temperature': 0.2,
    }
    if settings.openai_base_url:
        model_kwargs['base_url'] = settings.openai_base_url
    model = ChatOpenAI(**model_kwargs)
    try:
        response = model.invoke([
            ('system', f'''你正在执行项目内的 Story Skill。遵守下面的 Skill 契约，只完成用户请求，不声称执行了当前环境没有提供的浏览器、图片、文件写入或外部网络能力。当前适配范围是 prompt-only：需要落盘或工具调用时，输出清晰的下一步结构化计划。\n\nSKILL CONTRACT:\n{package.instructions[:120_000]}'''),
            ('human', f'''用户指令：{invocation.instruction}\n\n结构化输入：\n{json.dumps(invocation.payload, ensure_ascii=False, default=str)[:120_000]}'''),
        ])
    except Exception:
        logger.exception('prompt Skill execution failed: %s', invocation.skill_name)
        return {
            'status': 'failed',
            'skill': invocation.skill_name,
            'execution_scope': 'prompt-only',
            'message': '模型执行失败，请检查模型地址、密钥和上下文长度。',
        }
    return {
        'status': 'completed',
        'skill': invocation.skill_name,
        'execution_scope': 'prompt-only',
        'output': response.content,
    }

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.schemas import SkillDescriptor
from app.skills.registry import SkillRegistry, get_skill_registry


class SkillNotReadyError(RuntimeError):
    def __init__(self, skill_name: str):
        super().__init__(f'skill requires a dedicated web executor: {skill_name}')
        self.skill_name = skill_name


class SkillToolInput(BaseModel):
    skill_name: str = Field(pattern=r'^[a-z0-9-]+$')
    instruction: str = Field(min_length=1, max_length=4000)
    payload: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class SkillInvocation:
    skill_name: str
    instruction: str
    payload: dict[str, Any] = field(default_factory=dict)
    model_config_override: Any = None


SkillExecutor = Callable[[SkillInvocation], dict[str, Any]]


class StorySkillCapability:
    def __init__(self, registry: SkillRegistry):
        self.registry = registry
        self._executors: dict[str, tuple[str, SkillExecutor]] = {}
        self._requires_model: set[str] = set()

    def register(self, skill_name: str, executor_name: str, executor: SkillExecutor, requires_model: bool = False) -> None:
        self.registry.load(skill_name)
        self._executors[skill_name] = (executor_name, executor)
        if requires_model:
            self._requires_model.add(skill_name)

    def catalog(self) -> list[SkillDescriptor]:
        status_overrides = {
            name: 'needs_model'
            for name in self._requires_model
            if not get_settings().openai_api_key
        }
        return self.registry.catalog(
            {name: item[0] for name, item in self._executors.items()},
            status_overrides,
        )

    def invoke(self, skill_name: str, instruction: str, payload: dict[str, Any] | None = None, model_config_override: Any = None) -> dict[str, Any]:
        self.registry.load(skill_name)
        registered = self._executors.get(skill_name)
        if not registered:
            raise SkillNotReadyError(skill_name)
        invocation = SkillInvocation(
            skill_name=skill_name,
            instruction=instruction,
            payload=payload or {},
            model_config_override=model_config_override,
        )
        return registered[1](invocation)

    def as_langchain_tool(self) -> StructuredTool:
        return StructuredTool.from_function(
            func=self._tool_invoke,
            name='invoke_story_skill',
            description='调用一个已安装且已适配的网文 Skill，并返回其结构化执行结果。',
            args_schema=SkillToolInput,
        )

    def _tool_invoke(self, skill_name: str, instruction: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.invoke(skill_name, instruction, payload)


def route_story_intent(message: str) -> str:
    routes = [
        (('审查', '审稿', '检查章节', 'review'), 'story-review'),
        (('去ai', '去 ai', '去味', '太ai', '太 ai'), 'story-deslop'),
        (('封面', 'cover'), 'story-cover'),
        (('导入小说', '反向解析'), 'story-import'),
        (('短篇拆文', '拆短篇'), 'story-short-analyze'),
        (('长篇拆文', '黄金三章', '拆这本书'), 'story-long-analyze'),
        (('短篇排行', '短篇扫榜'), 'story-short-scan'),
        (('起点排行', '番茄排行', '长篇扫榜', '什么火'), 'story-long-scan'),
        (('写短篇', '盐言故事'), 'story-short-write'),
        (('写长篇', '开书', '写大纲', '续写'), 'story-long-write'),
        (('配置', '搭环境', '准备写书'), 'story-setup'),
        (('搜一下', '搜索一下', '联网搜索', '查一下', '帮我查', '搜搜', '最新排行', '搜索'), 'story-search'),
    ]
    normalized = message.lower()
    for keywords, skill_name in routes:
        if any(keyword in normalized for keyword in keywords):
            return skill_name
    return 'story'


def _execute_story_router(invocation: SkillInvocation) -> dict[str, Any]:
    capability = get_story_skill_capability()
    target = route_story_intent(invocation.instruction)
    preferred = invocation.payload.get('preferred_writing_skill')
    if preferred in {'story-long-write', 'story-short-write'} and target in {'story', 'story-long-write', 'story-short-write'}:
        target = preferred
    if target == 'story':
        return {
            'status': 'needs_input',
            'message': '请说明要写长篇、写短篇、拆文、扫榜、去 AI 味、制作封面还是审查章节。',
        }
    return capability.invoke(target, invocation.instruction, invocation.payload, invocation.model_config_override)


@lru_cache
def get_story_skill_capability() -> StorySkillCapability:
    from app.workflows.review import execute_review_skill
    from app.skills.deslop import execute_deslop_skill
    from app.skills.prompt import execute_prompt_skill
    from app.skills.search import execute_search_skill

    capability = StorySkillCapability(get_skill_registry())
    capability.register('story', 'router-v1', _execute_story_router)
    capability.register('story-review', 'langgraph-solo-v1', execute_review_skill)
    capability.register('story-deslop', 'deslop-v1', execute_deslop_skill, requires_model=True)
    capability.register('story-search', 'search-v1', execute_search_skill)
    for skill_name in (
        'story-import',
        'story-long-analyze',
        'story-long-scan',
        'story-long-write',
        'story-setup',
        'story-short-analyze',
        'story-short-scan',
        'story-short-write',
    ):
        capability.register(skill_name, 'prompt-only-v1', execute_prompt_skill, requires_model=True)
    return capability

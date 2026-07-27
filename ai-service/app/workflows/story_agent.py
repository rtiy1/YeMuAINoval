import json
from typing import Any, TypedDict
from uuid import uuid4

from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

from app.config import get_settings
from app.schemas import StoryAgentRequest, StoryAgentResponse
from app.skills.capability import SkillNotReadyError, get_story_skill_capability, route_story_intent
from app.skills.model_helper import create_chat_model, has_api_key


class AgentState(TypedDict, total=False):
    message: str
    requested_skill: str | None
    payload: dict[str, Any]
    selected_skill: str
    route: str
    invocation_status: str
    tool_result: dict[str, Any]
    model_config_override: Any


class SkillSelection(BaseModel):
    skill_name: str = Field(description='必须从给定能力目录中选择一个 skill name')
    reason: str = Field(description='一句话说明路由原因')


def select_skill(state: AgentState) -> dict[str, Any]:
    if state.get('requested_skill'):
        return {'selected_skill': state['requested_skill'], 'route': 'explicit'}
    settings = get_settings()
    override = state.get('model_config_override')
    capability = get_story_skill_capability()
    if has_api_key(override, settings):
        catalog = [item.model_dump() for item in capability.catalog()]
        model = create_chat_model(override, settings, default_temperature=0).with_structured_output(SkillSelection)
        prompt = ChatPromptTemplate.from_messages([
            ('system', '你是 Story Agent 的能力路由器。只从能力目录选择最匹配的 Skill；不要执行任务，不要编造能力。'),
            ('human', '能力目录：\n{catalog}\n\n用户请求：{message}'),
        ])
        try:
            selected = (prompt | model).invoke({
                'catalog': json.dumps(catalog, ensure_ascii=False),
                'message': state['message'],
            })
            if any(item['name'] == selected.skill_name for item in catalog):
                return {'selected_skill': selected.skill_name, 'route': f'model-catalog: {selected.reason}'}
        except Exception:
            pass
    return {'selected_skill': route_story_intent(state['message']), 'route': 'story-router'}


def invoke_skill_tool(state: AgentState) -> dict[str, Any]:
    capability = get_story_skill_capability()
    override = state.get('model_config_override')
    try:
        result = capability.invoke(
            state['selected_skill'],
            state['message'],
            state.get('payload', {}),
            override,
        )
        result_status = result.get('status') if isinstance(result, dict) else None
        invocation_status = result_status if result_status in {'needs_model', 'failed', 'needs_input'} else 'completed'
        update: dict[str, Any] = {'invocation_status': invocation_status, 'tool_result': result}
        routed_skill = result.get('skill') if isinstance(result, dict) else None
        if state['selected_skill'] == 'story' and isinstance(routed_skill, str):
            update['selected_skill'] = routed_skill
            update['route'] = f"story-router -> {routed_skill}"
        return update
    except SkillNotReadyError as error:
        return {
            'invocation_status': 'needs_adapter',
            'tool_result': {
                'skill': error.skill_name,
                'message': '该 Skill 已进入能力目录，但还需要独立的 Web executor 才能安全执行。',
            },
        }


def build_story_agent_graph():
    graph = StateGraph(AgentState)
    graph.add_node('select_skill', select_skill)
    graph.add_node('invoke_story_skill', invoke_skill_tool)
    graph.set_entry_point('select_skill')
    graph.add_edge('select_skill', 'invoke_story_skill')
    graph.add_edge('invoke_story_skill', END)
    return graph.compile()


story_agent_graph = build_story_agent_graph()


def run_story_agent(request: StoryAgentRequest) -> StoryAgentResponse:
    state = story_agent_graph.invoke({
        'message': request.message,
        'requested_skill': request.skill,
        'payload': request.payload,
        'model_config_override': request.model_config_override,
    })
    return StoryAgentResponse(
        run_id=str(uuid4()),
        status=state['invocation_status'],
        selected_skill=state['selected_skill'],
        route=state['route'],
        result=state['tool_result'],
    )

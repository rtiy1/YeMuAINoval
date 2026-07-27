import json
import logging
from typing import Literal

from pydantic import BaseModel, Field

from app.agent_instructions import (
    AGENT_EXECUTION_POLICY,
    EXECUTION_BOUNDARY_POLICY,
    NIGHT_RAIN_IDENTITY,
    STORY_FACT_POLICY,
    compose_system_prompt,
)
from app.config import get_settings
from app.model_content import model_content_text
from app.schemas import (
    AssistantPlanQuestion,
    StoryAgentRequest,
    WritingAssistantTurnRequest,
    WritingAssistantTurnResponse,
    WritingProposalRequest,
    WritingRequirements,
    WritingRequirementsPatch,
)
from app.skills.capability import SkillInvocation, get_story_skill_capability, route_story_intent
from app.skills.model_helper import create_chat_model, has_api_key
from app.workflows.story_agent import run_story_agent
from app.workflows.writing_assistant import generate_writing_proposal


logger = logging.getLogger(__name__)
WRITING_SKILLS = {'story-long-write', 'story-short-write'}
REQUIRED_WRITING_FIELDS = ('type', 'genre', 'style', 'premise')


def _web_search_turn(request: WritingAssistantTurnRequest) -> WritingAssistantTurnResponse:
    """联网搜索开关打开时：先检索，再用结果回答，不进入建书流程。"""
    from app.skills.search import execute_search_skill

    invocation = SkillInvocation(
        skill_name='story-search',
        instruction=request.message,
        payload={},
        model_config_override=request.model_config_override,
    )
    result = execute_search_skill(invocation)
    results = result.get('results') or []
    if result.get('status') == 'failed' or (not results and not result.get('summary')):
        reply = result.get('message') or '联网搜索失败，请稍后重试或配置 TAVILY_API_KEY。'
    elif result.get('summary'):
        reply = model_content_text(result['summary'])
    else:
        lines = [f'已检索到 {len(results)} 条结果：']
        for index, item in enumerate(results[:8], 1):
            lines.append(f"[{index}] {item.get('title', '')}\n{item.get('url', '')}")
        reply = '\n'.join(lines)
    return WritingAssistantTurnResponse(
        status='completed',
        phase='collecting_requirements',
        reply=reply,
        selected_skill='story-search',
        route='web-search',
        requirements=request.requirements,
        result=result,
    )

ASSISTANT_SYSTEM_PROMPT = compose_system_prompt(
    NIGHT_RAIN_IDENTITY,
    AGENT_EXECUTION_POLICY,
    STORY_FACT_POLICY,
    EXECUTION_BOUNDARY_POLICY,
    '''路由职责：
1. 对写书和短篇创作任务，先从自然对话提取已有信息，不把所有字段一次性做成问卷。
2. 已经明确的信息不得重复询问，不得擅自替换作者选择；无法确定时保持 null。
3. 非写作任务上下文足够时直接 ready 并选择 Skill；缺正文、项目或执行材料时只返回最关键的缺失项。
4. requirements 只返回本轮新识别且有文本依据的信息；missing 基于合并后的需求判断；questions 最多 1 项。

创作质量底线：
在给出创作判断时关注：主角目标是否明确、冲突是否升级、人物行为是否有动机、信息是否重复、爽点是否有事件支撑、章末是否形成期待、是否未经允许改写设定，以及是否出现模板腔、总结腔和明显 AI 套话。

回复简洁、有主见、像一位资深网文策划。输出必须符合 AssistantDecision schema。''',
)


class AssistantDecision(BaseModel):
    selected_skill: str = Field(description='从能力目录选择的 skill name')
    route_reason: str = Field(description='一句话说明选择原因')
    reply: str = Field(min_length=1, max_length=1000)
    requirements: WritingRequirementsPatch = Field(default_factory=WritingRequirementsPatch)
    missing: list[Literal['type', 'genre', 'style', 'premise', 'platform', 'title', 'intent', 'context']] = Field(default_factory=list)
    questions: list[AssistantPlanQuestion] = Field(default_factory=list, max_length=1)
    ready: bool = False


def _patch_dict(patch: WritingRequirementsPatch) -> dict[str, str]:
    return {
        key: value.strip()
        for key, value in patch.model_dump().items()
        if isinstance(value, str) and value.strip()
    }


def _merged_requirements(current: WritingRequirementsPatch, patch: WritingRequirementsPatch) -> WritingRequirementsPatch:
    values = _patch_dict(current)
    values.update(_patch_dict(patch))
    return WritingRequirementsPatch(**values)


def _writing_missing(requirements: WritingRequirementsPatch) -> list[str]:
    values = requirements.model_dump()
    return [field for field in REQUIRED_WRITING_FIELDS if not str(values.get(field) or '').strip()]


def _fallback_decision(request: WritingAssistantTurnRequest, selected_skill: str) -> AssistantDecision:
    current = request.requirements.model_dump()
    text = request.message.strip()
    patch: dict[str, str] = {}
    expected = next((field for field in REQUIRED_WRITING_FIELDS if not str(current.get(field) or '').strip()), None)
    if not current.get('type'):
        if '短篇' in text:
            patch['type'] = '短篇'
        elif '长篇' in text:
            patch['type'] = '长篇'
    if expected == 'genre' and not current.get('genre'):
        patch['genre'] = text[:30]
    elif expected == 'style' and not current.get('style'):
        patch['style'] = text[:80]
    elif expected == 'premise' and not current.get('premise'):
        patch['premise'] = text[:2000]
    selected_skill = (
        'story-short-write' if patch.get('type') == '短篇'
        else 'story-long-write' if patch.get('type') == '长篇'
        else selected_skill
    )
    merged = _merged_requirements(request.requirements, WritingRequirementsPatch(**patch))
    if selected_skill in WRITING_SKILLS or selected_skill == 'story':
        missing = _writing_missing(merged)
        field = missing[0] if missing else None
        prompts = {
            'type': AssistantPlanQuestion(id='writing_type', field='type', question='这个故事更适合写成长篇连载，还是节奏紧凑的短篇？', options=[
                {'label': '长篇', 'value': '长篇', 'description': '持续升级、适合连载'},
                {'label': '短篇', 'value': '短篇', 'description': '集中冲突、快速收束'},
            ]),
            'genre': AssistantPlanQuestion(id='writing_genre', field='genre', question='你希望它落在哪个题材里？', options=[
                {'label': '现代言情', 'value': '现代言情'}, {'label': '东方玄幻', 'value': '东方玄幻'},
                {'label': '悬疑推理', 'value': '悬疑推理'}, {'label': '都市现实', 'value': '都市现实'},
            ]),
            'style': AssistantPlanQuestion(id='writing_style', field='style', question='你最想突出哪种阅读体验或核心爽点？', options=[
                {'label': '逆袭打脸', 'value': '逆袭打脸'}, {'label': '重生复仇', 'value': '重生复仇'},
                {'label': '甜宠拉扯', 'value': '甜宠拉扯'}, {'label': '群像成长', 'value': '群像成长'},
            ]),
            'premise': AssistantPlanQuestion(id='writing_premise', field='premise', question='用一两句话说说主角、目标和最主要的阻碍是什么？'),
        }
        return AssistantDecision(
            selected_skill=selected_skill if selected_skill in WRITING_SKILLS else 'story-long-write',
            route_reason='fallback-writing-plan',
            reply=prompts[field].question if field else '信息已经足够，我来整理建书方案。',
            requirements=WritingRequirementsPatch(**patch),
            missing=missing,
            questions=[prompts[field]] if field else [],
            ready=not missing,
        )
    return AssistantDecision(
        selected_skill=selected_skill,
        route_reason='fallback-story-router',
        reply='我会使用最匹配的创作能力处理这个请求。',
        requirements=WritingRequirementsPatch(),
        ready=True,
    )


def _plan_turn(request: WritingAssistantTurnRequest) -> AssistantDecision:
    settings = get_settings()
    override = request.model_config_override
    explicit_skill = request.skill
    routed = explicit_skill or route_story_intent(request.message)
    if not has_api_key(override, settings):
        return _fallback_decision(request, routed)

    catalog = [item.model_dump() for item in get_story_skill_capability().catalog()]
    transcript = '\n'.join(f'{item.role}: {item.text}' for item in request.messages[-20:])
    human_prompt = f'''能力目录：
{json.dumps(catalog, ensure_ascii=False)}

强制 Skill：{explicit_skill or '无（自动选择）'}
已有创作需求：{json.dumps(request.requirements.model_dump(), ensure_ascii=False)}
最近对话：
{transcript or '无'}

用户本轮消息：{request.message}

判断下一步。若是写作 Skill，requirements 返回本轮新识别的信息；missing 返回合并已有信息后仍缺少的必填项。'''
    try:
        model = create_chat_model(override, settings, default_temperature=0.2).with_structured_output(AssistantDecision)
        decision = model.invoke([('system', ASSISTANT_SYSTEM_PROMPT), ('human', human_prompt)])
        names = {item['name'] for item in catalog}
        if explicit_skill:
            if explicit_skill in names:
                decision.selected_skill = explicit_skill
                decision.route_reason = 'explicit'
            else:
                return AssistantDecision(
                    selected_skill='story',
                    route_reason='explicit-unavailable',
                    reply='指定的 Skill 不在当前能力目录中，请选择已安装能力或直接描述目标。',
                    missing=['intent'],
                    questions=[AssistantPlanQuestion(
                        id='available_skill_intent',
                        field='intent',
                        question='你希望我完成写作、审稿、分析、搜索还是其他哪类任务？',
                    )],
                    ready=False,
                )
        elif decision.selected_skill not in names:
            decision.selected_skill = routed
            decision.route_reason = 'story-router-fallback'
        decision.questions = decision.questions[:1]
        return decision
    except Exception:
        logger.exception('writing assistant planning failed; using fallback')
        return _fallback_decision(request, routed)


def run_writing_assistant_turn(request: WritingAssistantTurnRequest) -> WritingAssistantTurnResponse:
    if request.web_search:
        return _web_search_turn(request)
    decision = _plan_turn(request)
    requirements = _merged_requirements(request.requirements, decision.requirements)
    selected_skill = decision.selected_skill

    if selected_skill in WRITING_SKILLS:
        if requirements.type == '短篇':
            selected_skill = 'story-short-write'
        elif requirements.type == '长篇':
            selected_skill = 'story-long-write'
        missing = _writing_missing(requirements)
        if missing:
            questions = [question for question in decision.questions if question.field in missing][:1]
            if not questions:
                fallback = _fallback_decision(request, selected_skill)
                questions = fallback.questions
            return WritingAssistantTurnResponse(
                status='needs_input',
                phase='collecting_requirements',
                reply=decision.reply,
                selected_skill=selected_skill,
                route=decision.route_reason,
                requirements=requirements,
                missing=missing,
                questions=questions,
            )

        proposal_response = generate_writing_proposal(WritingProposalRequest(
            requirements=WritingRequirements(**requirements.model_dump(exclude_none=True)),
            messages=request.messages,
            model_config=request.model_config_override,
        ))
        return WritingAssistantTurnResponse(
            status=proposal_response.status,
            phase=proposal_response.phase,
            reply=proposal_response.reply,
            selected_skill=selected_skill,
            route=decision.route_reason,
            requirements=requirements,
            missing=proposal_response.missing,
            proposal=proposal_response.proposal,
        )

    if not decision.ready or decision.questions:
        return WritingAssistantTurnResponse(
            status='needs_input',
            phase='collecting_requirements',
            reply=decision.reply,
            selected_skill=selected_skill,
            route=decision.route_reason,
            requirements=requirements,
            missing=decision.missing,
            questions=decision.questions,
        )

    if selected_skill == 'story-review' and not str(request.payload.get('content') or '').strip():
        question = AssistantPlanQuestion(
            id='review_content',
            field='context',
            question='请粘贴要审查的章节正文，或从编辑器中发起审稿。',
        )
        return WritingAssistantTurnResponse(
            status='needs_input',
            phase='collecting_requirements',
            reply=question.question,
            selected_skill=selected_skill,
            route=decision.route_reason,
            requirements=requirements,
            missing=['context'],
            questions=[question],
        )

    agent_response = run_story_agent(StoryAgentRequest(
        message=request.message,
        skill=selected_skill,
        payload=request.payload,
        model_config=request.model_config_override,
    ))
    result = agent_response.result
    reply = model_content_text(result.get('message') or result.get('summary') or decision.reply) if isinstance(result, dict) else decision.reply
    response_phase = 'completed' if agent_response.status == 'completed' else 'collecting_requirements'
    return WritingAssistantTurnResponse(
        status=agent_response.status,
        phase=response_phase,
        reply=reply,
        selected_skill=agent_response.selected_skill,
        route=agent_response.route,
        requirements=requirements,
        result=result,
    )

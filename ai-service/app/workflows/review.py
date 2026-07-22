import logging
import re
from typing import Any, TypedDict

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

from app.config import get_settings
from app.schemas import ChapterReviewRequest, ReviewFinding, ReviewResult
from app.skills.capability import SkillInvocation
from app.skills.story_review import deduplicate_findings, load_review_resources, run_skill_checks, select_rubric


logger = logging.getLogger(__name__)
SEVERITY_PENALTIES = {'S1': 25, 'S2': 12, 'S3': 5, 'S4': 1}


class ReviewState(TypedDict, total=False):
    title: str
    genre: str
    platform: str
    mode: str
    content: str
    rubric: str
    rubric_source: str
    skill_version: str
    metrics: dict[str, int | float]
    deterministic_findings: list[dict[str, str]]
    llm_result: dict[str, Any] | None
    result: dict[str, Any]


class LlmReview(BaseModel):
    summary: str = Field(description='用一句话概括本章最重要的审查结论')
    strengths: list[str] = Field(default_factory=list, max_length=4)
    findings: list[ReviewFinding] = Field(default_factory=list, max_length=16)


def normalize_input(state: ReviewState) -> dict[str, Any]:
    content = re.sub(r'\r\n?', '\n', state['content']).strip()
    paragraphs = [item.strip() for item in re.split(r'\n\s*\n', content) if item.strip()]
    sentences = [item for item in re.split(r'[。！？!?]+', content) if item.strip()]
    visible_characters = len(re.sub(r'\s', '', content))
    rubric = select_rubric(state['platform'], state['genre'])
    resources = load_review_resources(rubric)
    return {
        'content': content,
        'rubric': rubric,
        'rubric_source': resources.rubric_source,
        'skill_version': resources.version,
        'metrics': {
            'characters': visible_characters,
            'paragraphs': len(paragraphs),
            'sentences': len(sentences),
            'average_sentence_length': round(visible_characters / max(len(sentences), 1), 1),
            'dialogue_count': len(re.findall(r'[“「『][^”」』]+[”」』]', content)),
        },
    }


def deterministic_review(state: ReviewState) -> dict[str, Any]:
    return {'deterministic_findings': run_skill_checks(state['content'], state['rubric'])}


def llm_review(state: ReviewState) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        return {'llm_result': None}
    resources = load_review_resources(state['rubric'])
    model_kwargs = {'model': settings.openai_model, 'api_key': settings.openai_api_key, 'temperature': 0.1}
    if settings.openai_base_url:
        model_kwargs['base_url'] = settings.openai_base_url
    model = ChatOpenAI(**model_kwargs).with_structured_output(LlmReview)
    prompt = ChatPromptTemplate.from_messages([
        ('system', '''你正在执行 story-review Skill 的 solo 模式。审查只找问题，不续写、不改写正文。每条 finding 必须引用原文证据，并严格输出 severity/category/location/evidence/issue/fix。无法从单章证明的前文一致性问题不要猜测。平台规则只作为 advisory，不把机械字数或密度指标当硬门槛。\n\nSKILL CONTRACT:\n{skill_contract}\n\nQUALITY RUBRIC:\n{quality_rubric}\n\nPLATFORM RUBRIC:\n{platform_rubric}\n\nCHECKLIST:\n{quality_checklist}\n\nANTI-AI RULES:\n{anti_ai_writing}\n\nBANNED WORDS:\n{banned_words}'''),
        ('human', '题材：{genre}\n平台：{platform}\n章节：{title}\n\n正文：\n{content}'),
    ])
    try:
        response = (prompt | model).invoke({
            'skill_contract': resources.instructions,
            'quality_rubric': resources.quality_rubric,
            'platform_rubric': resources.platform_rubric,
            'quality_checklist': resources.quality_checklist,
            'anti_ai_writing': resources.anti_ai_writing,
            'banned_words': resources.banned_words,
            'genre': state['genre'],
            'platform': state['platform'],
            'title': state['title'],
            'content': state['content'][:120_000],
        })
        return {'llm_result': response.model_dump()}
    except Exception:
        logger.exception('optional LLM review failed; continuing with deterministic Skill checks')
        return {'llm_result': None}


def synthesize(state: ReviewState) -> dict[str, Any]:
    llm = state.get('llm_result')
    llm_findings = llm.get('findings', []) if llm else []
    findings = deduplicate_findings([*state.get('deterministic_findings', []), *llm_findings])
    counts = {severity: sum(1 for item in findings if item['severity'] == severity) for severity in ('S1', 'S2', 'S3', 'S4')}
    if counts['S1']:
        verdict = 'REJECT'
    elif counts['S2'] or counts['S3'] >= 5:
        verdict = 'CONCERNS'
    else:
        verdict = 'APPROVE'
    score = max(0, 100 - sum(SEVERITY_PENALTIES[item['severity']] for item in findings))
    summary = llm['summary'] if llm else _rule_summary(verdict, counts)
    strengths = llm.get('strengths', []) if llm else []
    if not strengths:
        strengths = ['已完成格式、退化、AI 写作模式与平台 rubric 的确定性检查。']
    fallback = 'not required (solo requested)' if state['mode'] == 'solo' else 'agent tool unavailable -> solo'
    result = {
        'Requested Mode': state['mode'],
        'Effective Mode': 'solo',
        'Fallback': fallback,
        'Rubric': state['rubric'],
        'Rubric Source': state['rubric_source'],
        'skill': 'story-review',
        'skill_version': state['skill_version'],
        'verdict': verdict,
        'score': score,
        'summary': summary,
        'strengths': strengths[:4],
        'issues': [item['issue'] for item in findings[:8]],
        'suggestions': [item['fix'] for item in findings[:8]] or ['当前确定性检查未发现必须修改的问题，发布前仍建议人工通读。'],
        'metrics': state['metrics'],
        'severity_counts': counts,
        'findings': findings,
    }
    validated = ReviewResult.model_validate(result)
    return {'result': validated.model_dump(by_alias=True)}


def _rule_summary(verdict: str, counts: dict[str, int]) -> str:
    total = sum(counts.values())
    if total == 0:
        return 'Skill 规则审查未发现确定性问题；当前为无模型的 solo 审查。'
    return f"Skill 规则审查发现 {total} 项：S1 {counts['S1']}、S2 {counts['S2']}、S3 {counts['S3']}、S4 {counts['S4']}，结论为 {verdict}。"


def build_review_graph():
    graph = StateGraph(ReviewState)
    graph.add_node('normalize_input', normalize_input)
    graph.add_node('skill_checks', deterministic_review)
    graph.add_node('llm_review', llm_review)
    graph.add_node('synthesize', synthesize)
    graph.set_entry_point('normalize_input')
    graph.add_edge('normalize_input', 'skill_checks')
    graph.add_edge('skill_checks', 'llm_review')
    graph.add_edge('llm_review', 'synthesize')
    graph.add_edge('synthesize', END)
    return graph.compile()


review_graph = build_review_graph()


def execute_review_skill(invocation: SkillInvocation) -> dict[str, Any]:
    request = ChapterReviewRequest.model_validate(invocation.payload)
    state = review_graph.invoke(request.model_dump())
    return ReviewResult.model_validate(state['result']).model_dump(by_alias=True)

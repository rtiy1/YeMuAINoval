from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelConfig(BaseModel):
    """用户自定义的 LLM 模型配置，覆盖服务端默认。"""
    api_base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    context_window: int | None = None


class ChapterReviewRequest(BaseModel):
    title: str = Field(default='未命名章节', min_length=1, max_length=120)
    genre: str = Field(default='网络小说', min_length=1, max_length=40)
    platform: str = Field(default='通用网文', min_length=1, max_length=40)
    mode: Literal['full', 'lean', 'solo'] = 'full'
    content: str = Field(min_length=1, max_length=500_000)
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


class ReviewFinding(BaseModel):
    severity: Literal['S1', 'S2', 'S3', 'S4']
    category: Literal['structure', 'character', 'prose', 'consistency', 'platform', 'factual', 'format', 'causal', 'rule_boundary']
    location: str
    evidence: str
    issue: str
    fix: str


class ReviewResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    requested_mode: Literal['full', 'lean', 'solo'] = Field(alias='Requested Mode')
    effective_mode: Literal['solo'] = Field(alias='Effective Mode')
    fallback: str = Field(alias='Fallback')
    rubric: Literal['fanqie', 'qidian', 'zhihu', 'generic web-fiction'] = Field(alias='Rubric')
    rubric_source: Literal['file', 'embedded fallback'] = Field(alias='Rubric Source')
    skill: str = 'story-review'
    skill_version: str = 'unknown'
    verdict: Literal['APPROVE', 'CONCERNS', 'REJECT']
    score: int = Field(ge=0, le=100)
    summary: str
    strengths: list[str]
    issues: list[str]
    suggestions: list[str]
    metrics: dict[str, int | float]
    severity_counts: dict[str, int]
    findings: list[ReviewFinding]


class ChapterReviewResponse(BaseModel):
    run_id: str
    status: str
    result: ReviewResult


class SkillDescriptor(BaseModel):
    name: str
    version: str | None = None
    description: str
    status: Literal['ready', 'needs_model', 'registered', 'unavailable']
    executor: str | None = None


class SkillCatalogResponse(BaseModel):
    skills: list[SkillDescriptor]


class StoryAgentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    skill: str | None = Field(default=None, pattern=r'^[a-z0-9-]+$')
    payload: dict[str, Any] = Field(default_factory=dict)
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


class StoryAgentResponse(BaseModel):
    run_id: str
    status: Literal['completed', 'needs_model', 'needs_adapter', 'failed']
    selected_skill: str
    route: str
    result: dict[str, Any]


class WritingAssistantMessage(BaseModel):
    role: Literal['user', 'assistant']
    text: str = Field(min_length=1, max_length=4000)


class WritingRequirements(BaseModel):
    type: Literal['长篇', '短篇']
    genre: str = Field(min_length=1, max_length=30)
    style: str = Field(min_length=1, max_length=80)
    premise: str = Field(min_length=1, max_length=2000)
    platform: str = Field(default='通用网文', max_length=40)
    title: str = Field(default='', max_length=80)


class WritingProposalChapter(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=5000)


class WritingProposal(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    type: Literal['长篇', '短篇']
    genre: str = Field(min_length=1, max_length=30)
    style: str = Field(min_length=1, max_length=80)
    tone: str = Field(min_length=1, max_length=2000)
    chapters: list[WritingProposalChapter] = Field(min_length=1, max_length=100)


class WritingProposalRequest(BaseModel):
    requirements: WritingRequirements
    messages: list[WritingAssistantMessage] = Field(default_factory=list, max_length=20)
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


class WritingProposalResponse(BaseModel):
    status: Literal['completed', 'needs_model', 'failed']
    phase: Literal['collecting_requirements', 'awaiting_confirmation']
    reply: str
    missing: list[str] = Field(default_factory=list)
    selected_skill: Literal['story-long-write', 'story-short-write']
    proposal: WritingProposal | None = None

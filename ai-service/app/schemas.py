from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelConfig(BaseModel):
    """用户自定义的 LLM 模型配置，覆盖服务端默认。"""
    provider: Literal['openai', 'anthropic'] | None = None
    api_base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    reasoning_effort: Literal['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    context_window: int | None = None
    allow_server_fallback: bool = True


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
    status: Literal['completed', 'needs_input', 'needs_model', 'needs_adapter', 'failed']
    selected_skill: str
    route: str
    result: dict[str, Any]


class StoryMemoryCandidate(BaseModel):
    type: Literal['character_state', 'event', 'world_rule', 'chapter_summary', 'canon_fact', 'voice_habit']
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=4000)
    importance: int = Field(default=3, ge=1, le=5)
    character_name: str = Field(default='', max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=8)
    reason: str = Field(default='', max_length=500)
    replaces_memory_id: str | None = None


class StoryMemoryExtractRequest(BaseModel):
    chapter_title: str = Field(default='当前章节', min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=500_000)
    writing_context: dict[str, Any] = Field(default_factory=dict)
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


class StoryMemoryExtractResponse(BaseModel):
    status: Literal['completed', 'needs_model', 'failed']
    message: str
    candidates: list[StoryMemoryCandidate] = Field(default_factory=list, max_length=40)


class ContextCompactMessage(BaseModel):
    role: Literal['user', 'assistant']
    text: str = Field(min_length=1, max_length=12000)


class ContextCompactRequest(BaseModel):
    existing_summary: str = Field(default='', max_length=30000)
    messages: list[ContextCompactMessage] = Field(min_length=1, max_length=80)
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


class ContextCompactResponse(BaseModel):
    status: Literal['completed', 'needs_model', 'failed']
    message: str
    summary: str = Field(default='', max_length=30000)
    compacted_messages: int = Field(default=0, ge=0)


class EditProposalBlock(BaseModel):
    original: str = Field(default='', max_length=100_000)
    replacement: str = Field(default='', max_length=100_000)
    reason: str = Field(min_length=1, max_length=1000)


class EditProposal(BaseModel):
    revised_text: str = Field(max_length=500_000)
    summary: str = Field(min_length=1, max_length=1000)
    blocks: list[EditProposalBlock] = Field(default_factory=list, max_length=200)


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


class WritingRequirementsPatch(BaseModel):
    type: Literal['长篇', '短篇'] | None = None
    genre: str | None = Field(default=None, max_length=30)
    style: str | None = Field(default=None, max_length=80)
    premise: str | None = Field(default=None, max_length=2000)
    platform: str | None = Field(default=None, max_length=40)
    title: str | None = Field(default=None, max_length=80)


class AssistantQuestionOption(BaseModel):
    label: str = Field(min_length=1, max_length=50)
    value: str = Field(min_length=1, max_length=100)
    description: str = Field(default='', max_length=160)


class AssistantPlanQuestion(BaseModel):
    id: str = Field(min_length=1, max_length=40, pattern=r'^[a-z0-9_-]+$')
    field: Literal['type', 'genre', 'style', 'premise', 'platform', 'title', 'intent', 'context']
    question: str = Field(min_length=1, max_length=300)
    options: list[AssistantQuestionOption] = Field(default_factory=list, max_length=6)
    allow_custom: bool = True
    multiple: bool = False


class WritingAssistantTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    messages: list[WritingAssistantMessage] = Field(default_factory=list, max_length=20)
    requirements: WritingRequirementsPatch = Field(default_factory=WritingRequirementsPatch)
    skill: str | None = Field(default=None, pattern=r'^[a-z0-9-]+$')
    payload: dict[str, Any] = Field(default_factory=dict)
    web_search: bool = False
    model_config_override: ModelConfig | None = Field(default=None, alias='model_config')


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


class WritingAssistantTurnResponse(BaseModel):
    status: Literal['needs_input', 'ready', 'completed', 'needs_model', 'needs_adapter', 'failed']
    phase: Literal['collecting_requirements', 'awaiting_confirmation', 'completed']
    reply: str
    selected_skill: str
    route: str
    requirements: WritingRequirementsPatch
    missing: list[str] = Field(default_factory=list)
    questions: list[AssistantPlanQuestion] = Field(default_factory=list)
    result: dict[str, Any] | None = None
    proposal: WritingProposal | None = None


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

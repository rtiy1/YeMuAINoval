import logging

from fastapi import Depends, FastAPI, Header, HTTPException

from app.config import get_settings
from app.schemas import (
    ChapterReviewRequest,
    ChapterReviewResponse,
    ReviewResult,
    SkillCatalogResponse,
    StoryAgentRequest,
    StoryAgentResponse,
)
from app.skills.capability import get_story_skill_capability
from app.skills.registry import SkillRegistryError
from app.workflows.story_agent import run_story_agent

logger = logging.getLogger(__name__)
app = FastAPI(title='Story Studio AI Service', version='0.1.0')


async def verify_service_token(x_service_token: str | None = Header(default=None)) -> None:
    settings = get_settings()
    if x_service_token != settings.ai_service_token:
        raise HTTPException(status_code=401, detail='invalid service token')


@app.get('/health')
async def health():
    settings = get_settings()
    catalog = get_story_skill_capability().catalog()
    return {
        'ok': True,
        'service': 'story-ai',
        'llm_configured': bool(settings.openai_api_key),
        'model': settings.openai_model,
        'skills_installed': len(catalog),
        'skills_ready': sum(1 for item in catalog if item.status == 'ready'),
        'skills_needing_model': sum(1 for item in catalog if item.status == 'needs_model'),
    }


@app.get('/v1/skills', response_model=SkillCatalogResponse, dependencies=[Depends(verify_service_token)])
async def list_skills():
    catalog = get_story_skill_capability().catalog()
    return SkillCatalogResponse(skills=catalog)


@app.post('/v1/agents/story', response_model=StoryAgentResponse, dependencies=[Depends(verify_service_token)])
async def invoke_story_agent(request: StoryAgentRequest):
    try:
        return run_story_agent(request)
    except SkillRegistryError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        logger.exception('story agent failed')
        raise HTTPException(status_code=500, detail='story agent failed') from error


@app.post('/v1/reviews/chapter', response_model=ChapterReviewResponse, dependencies=[Depends(verify_service_token)])
async def review_chapter(request: ChapterReviewRequest):
    try:
        agent_result = run_story_agent(StoryAgentRequest(
            message=f'使用 story-review 审查章节《{request.title}》',
            skill='story-review',
            payload=request.model_dump(),
            model_config_override=request.model_config_override,
        ))
        result = ReviewResult.model_validate(agent_result.result)
        return ChapterReviewResponse(run_id=agent_result.run_id, status=agent_result.status, result=result)
    except Exception as error:
        logger.exception('chapter review failed')
        raise HTTPException(status_code=500, detail='chapter review failed') from error

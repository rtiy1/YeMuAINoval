from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    ai_service_token: str = 'local-ai-service-token'
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str = 'gpt-4o-mini'
    anthropic_api_key: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    tavily_api_key: str | None = None
    story_skills_root: str = str(PROJECT_ROOT / 'skills')
    story_node_bin: str = 'node'


@lru_cache
def get_settings() -> Settings:
    return Settings()

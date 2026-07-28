"""模型配置解析 helper。

合并用户自定义的模型配置（per-request）与服务端默认设置，
按 provider 选择 ChatOpenAI 或 ChatAnthropic。
"""

from typing import Any

from langchain_openai import ChatOpenAI

from app.config import Settings


def _provider_of(override: Any | None) -> str:
    return getattr(override, 'provider', None) or 'openai'


def _allow_server_fallback(override: Any | None) -> bool:
    return override is None or getattr(override, 'allow_server_fallback', True)


def _is_reasoning_model(model: str) -> bool:
    normalized = str(model or '').lower()
    return normalized.startswith(('o1', 'o3', 'o4', 'gpt-5')) or 'codex' in normalized


def _supports_responses_model(model: str) -> bool:
    """Conservative allowlist for text models that support the Responses API."""
    normalized = str(model or '').strip().lower()
    return normalized.startswith((
        'gpt-4o',
        'gpt-4.1',
        'gpt-4.5',
        'gpt-5',
        'o1',
        'o3',
        'o4',
    )) or 'codex' in normalized


def _supports_openai_responses(base_url: str | None) -> bool:
    """Only opt in automatically for OpenAI's first-party endpoint.

    The project supports arbitrary OpenAI-compatible gateways. Many of those
    implement Chat Completions but not Responses, so a custom endpoint keeps the
    compatibility path unless it is explicitly the standard OpenAI API URL.
    """
    if not base_url:
        return True
    normalized = str(base_url).strip().rstrip('/').lower()
    return normalized in {'https://api.openai.com', 'https://api.openai.com/v1'}


def resolve_model_kwargs(
    override: Any | None,
    settings: Settings,
    default_temperature: float = 0.2,
) -> dict[str, Any]:
    """合并 override 与 settings 默认值，返回按 provider 分流的模型 kwargs。

    override 中非 None 的字段覆盖 settings 默认值。
    OpenAI: 始终含 model / api_key / temperature；base_url、max_tokens 仅在非空时加入。
    Anthropic: 始终含 model / api_key / temperature / max_tokens（必填，默认 4096）；
    base_url 非空时映射为 anthropic_api_url。
    返回 dict 额外含 'provider'。
    """
    ov = override
    provider = _provider_of(ov)
    if provider == 'anthropic':
        model = (ov.model if ov and ov.model else None) or settings.anthropic_model or 'claude-3-5-sonnet-latest'
        api_key = (ov.api_key if ov and ov.api_key else None) or (settings.anthropic_api_key if _allow_server_fallback(ov) else None)
        temperature = default_temperature
        if ov and ov.temperature is not None:
            temperature = max(0.0, min(2.0, float(ov.temperature)))
        base_url = (ov.api_base_url if ov and ov.api_base_url else None) or settings.anthropic_base_url
        max_tokens = (ov.max_tokens if ov and ov.max_tokens is not None else None) or 4096
        kwargs: dict[str, Any] = {
            'provider': 'anthropic',
            'model': model,
            'api_key': api_key,
            'temperature': temperature,
            'max_tokens': int(max_tokens),
        }
        if base_url:
            kwargs['anthropic_api_url'] = base_url
        return kwargs

    model = (ov.model if ov and ov.model else None) or settings.openai_model
    api_key = (ov.api_key if ov and ov.api_key else None) or (settings.openai_api_key if _allow_server_fallback(ov) else None)
    temperature = default_temperature
    if ov and ov.temperature is not None:
        temperature = max(0.0, min(2.0, float(ov.temperature)))
    base_url = (ov.api_base_url if ov and ov.api_base_url else None) or settings.openai_base_url
    max_tokens = (ov.max_tokens if ov and ov.max_tokens is not None else None)
    reasoning_effort = ov.reasoning_effort if ov and ov.reasoning_effort else None
    kwargs = {
        'provider': 'openai',
        'model': model,
        'api_key': api_key,
    }
    is_reasoning_model = _is_reasoning_model(model)
    uses_responses_api = (
        _supports_openai_responses(base_url)
        and _supports_responses_model(model)
    )
    if uses_responses_api:
        kwargs.update({
            'use_responses_api': True,
            'output_version': 'responses/v1',
        })
        if is_reasoning_model:
            reasoning: dict[str, Any] = {'summary': 'auto'}
            if reasoning_effort:
                reasoning['effort'] = reasoning_effort
            kwargs['reasoning'] = reasoning
    elif reasoning_effort:
        kwargs['reasoning_effort'] = reasoning_effort
    if not reasoning_effort and not is_reasoning_model:
        kwargs['temperature'] = temperature
    if base_url:
        kwargs['base_url'] = base_url
    if max_tokens:
        kwargs['max_tokens'] = int(max_tokens)
    return kwargs


def has_api_key(override: Any | None, settings: Settings) -> bool:
    """判断是否有可用的 API Key（override 优先，回退 settings，按 provider）。"""
    if override and override.api_key:
        return True
    if not _allow_server_fallback(override):
        return False
    if _provider_of(override) == 'anthropic':
        return bool(settings.anthropic_api_key)
    return bool(settings.openai_api_key)


def resolve_context_window(override: Any | None, settings: Settings) -> int | None:
    """获取上下文窗口大小（override 优先，settings 默认无）。"""
    if override and override.context_window is not None:
        return int(override.context_window)
    return None


def truncate_for_context(
    text: str,
    context_window: int | None,
    max_tokens: int | None,
    char_budget: int = 120_000,
) -> str:
    """按上下文窗口截断输入文本，预留输出空间。

    context_window 和 max_tokens 以 token 为单位，这里粗略按 1 token ≈ 3 字符估算
    （中文约 1-2 字符/token，英文约 4 字符/token，取保守值）。
    若未配置 context_window，回退到 char_budget 字符上限。
    """
    if not text:
        return text
    if context_window and context_window > 0:
        reserve = int(max_tokens or 0)
        available_tokens = max(100, context_window - reserve)
        # 粗略 token→字符转换：保守取 3 字符/token
        char_limit = available_tokens * 3
        if char_limit < len(text):
            return text[:char_limit]
        return text
    if len(text) > char_budget:
        return text[:char_budget]
    return text


def create_chat_model(override: Any | None, settings: Settings, default_temperature: float = 0.2):
    """按 provider 构造聊天模型实例，合并 override 配置。"""
    kwargs = resolve_model_kwargs(override, settings, default_temperature)
    provider = kwargs.pop('provider', 'openai')
    if provider == 'anthropic':
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(**kwargs)
    return ChatOpenAI(**kwargs)

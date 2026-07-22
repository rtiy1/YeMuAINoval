"""模型配置解析 helper。

合并用户自定义的模型配置（per-request）与服务端默认设置，
统一供 4 个 ChatOpenAI 调用点使用。
"""

from typing import Any

from langchain_openai import ChatOpenAI

from app.config import Settings


def resolve_model_kwargs(
    override: Any | None,
    settings: Settings,
    default_temperature: float = 0.2,
) -> dict[str, Any]:
    """合并 override 与 settings 默认值，返回 ChatOpenAI 可用的 kwargs。

    override 中非 None 的字段覆盖 settings 默认值。
    返回 dict 始终含 model / api_key / temperature；
    base_url 仅在非空时加入；max_tokens 仅在非空时加入。
    """
    ov = override
    model = (ov.model if ov and ov.model else None) or settings.openai_model
    api_key = (ov.api_key if ov and ov.api_key else None) or settings.openai_api_key
    temperature = default_temperature
    if ov and ov.temperature is not None:
        temperature = max(0.0, min(2.0, float(ov.temperature)))
    base_url = (ov.api_base_url if ov and ov.api_base_url else None) or settings.openai_base_url
    max_tokens = (ov.max_tokens if ov and ov.max_tokens is not None else None)

    kwargs: dict[str, Any] = {
        'model': model,
        'api_key': api_key,
        'temperature': temperature,
    }
    if base_url:
        kwargs['base_url'] = base_url
    if max_tokens:
        kwargs['max_tokens'] = int(max_tokens)
    return kwargs


def has_api_key(override: Any | None, settings: Settings) -> bool:
    """判断是否有可用的 API Key（override 优先，回退 settings）。"""
    if override and override.api_key:
        return True
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


def create_chat_model(override: Any | None, settings: Settings, default_temperature: float = 0.2) -> ChatOpenAI:
    """直接构造 ChatOpenAI 实例，合并 override 配置。"""
    return ChatOpenAI(**resolve_model_kwargs(override, settings, default_temperature))

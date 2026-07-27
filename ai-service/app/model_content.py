import json
from collections.abc import Mapping, Sequence
from typing import Any


TEXT_KEYS = ('text', 'content', 'output', 'message', 'summary', 'reply', 'revised_text')


def model_content_text(value: Any, _seen: set[int] | None = None) -> str:
    """Normalize OpenAI/Anthropic/LangChain text and content-block responses."""
    if value is None:
        return ''
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)

    seen = _seen if _seen is not None else set()
    identity = id(value)
    if identity in seen:
        return ''
    seen.add(identity)

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return '\n'.join(filter(None, (model_content_text(item, seen) for item in value))).strip()

    if hasattr(value, 'model_dump'):
        value = value.model_dump()
    elif hasattr(value, 'text'):
        return model_content_text(value.text, seen)

    if isinstance(value, Mapping):
        for key in TEXT_KEYS:
            if key in value:
                text = model_content_text(value[key], seen)
                if text:
                    return text
        try:
            return json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return ''

    return str(value).strip()

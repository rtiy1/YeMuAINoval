import json
import re
from collections.abc import Mapping, Sequence
from typing import Any


TEXT_KEYS = ('text', 'content', 'output', 'message', 'summary', 'reply', 'revised_text')
NON_OUTPUT_BLOCK_TYPES = {
    'reasoning',
    'thinking',
    'reasoning_content',
    'tool_use',
    'tool_call',
    'function_call',
    'input_json_delta',
}
HIDDEN_REASONING_TAGS = ('think', 'thinking', 'analysis', 'reasoning')
HIDDEN_REASONING_PATTERN = re.compile(
    r'<(?P<tag>think|thinking|analysis|reasoning)\b[^>]*>.*?</(?P=tag)\s*>',
    re.IGNORECASE | re.DOTALL,
)
UNCLOSED_REASONING_PATTERN = re.compile(
    r'<(?:think|thinking|analysis|reasoning)\b[^>]*>.*\Z',
    re.IGNORECASE | re.DOTALL,
)


def strip_hidden_reasoning_text(value: str) -> str:
    """Remove provider-specific inline thinking tags from user-visible text."""
    text = str(value or '')
    previous = None
    while text != previous:
        previous = text
        text = HIDDEN_REASONING_PATTERN.sub('', text)
    return UNCLOSED_REASONING_PATTERN.sub('', text).strip()


def model_content_text(value: Any, _seen: set[int] | None = None) -> str:
    """Normalize OpenAI/Anthropic/LangChain text and content-block responses."""
    if value is None:
        return ''
    if isinstance(value, str):
        return strip_hidden_reasoning_text(value)
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
        block_type = str(value.get('type') or '')
        if block_type in NON_OUTPUT_BLOCK_TYPES:
            return ''
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

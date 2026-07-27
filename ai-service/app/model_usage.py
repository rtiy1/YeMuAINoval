from __future__ import annotations

import math
from typing import Any


def _positive_int(*values: Any) -> int:
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            return number
    return 0


def model_token_usage(message: Any = None, input_text: str = '', output_text: str = '') -> dict[str, Any]:
    usage = getattr(message, 'usage_metadata', None) or {}
    response_metadata = getattr(message, 'response_metadata', None) or {}
    provider_usage = response_metadata.get('token_usage') or response_metadata.get('usage') or {}
    input_details = usage.get('input_token_details') or provider_usage.get('prompt_tokens_details') or {}
    output_details = usage.get('output_token_details') or provider_usage.get('completion_tokens_details') or {}

    input_tokens = _positive_int(
        usage.get('input_tokens'),
        provider_usage.get('input_tokens'),
        provider_usage.get('prompt_tokens'),
    )
    output_tokens = _positive_int(
        usage.get('output_tokens'),
        provider_usage.get('output_tokens'),
        provider_usage.get('completion_tokens'),
    )
    cached_input_tokens = _positive_int(
        input_details.get('cache_read'),
        input_details.get('cached_tokens'),
        provider_usage.get('cached_input_tokens'),
    )
    reasoning_output_tokens = _positive_int(
        output_details.get('reasoning'),
        output_details.get('reasoning_tokens'),
        provider_usage.get('reasoning_output_tokens'),
    )
    has_provider_usage = bool(input_tokens or output_tokens or cached_input_tokens or reasoning_output_tokens)
    if not has_provider_usage:
        input_tokens = max(1, math.ceil(len(str(input_text or '')) / 2.2)) if input_text else 0
        output_tokens = max(1, math.ceil(len(str(output_text or '')) / 2.2)) if output_text else 0

    total_tokens = _positive_int(
        usage.get('total_tokens'),
        provider_usage.get('total_tokens'),
        input_tokens + output_tokens,
    )
    return {
        'input_tokens': input_tokens,
        'cached_input_tokens': cached_input_tokens,
        'output_tokens': output_tokens,
        'reasoning_output_tokens': reasoning_output_tokens,
        'total_tokens': total_tokens or input_tokens + output_tokens,
        'estimated': not has_provider_usage,
    }

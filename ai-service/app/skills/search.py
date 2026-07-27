"""联网搜索 Skill。

配置 TAVILY_API_KEY 时走 Tavily API；否则零配置回退 DuckDuckGo HTML。
只有真正发起过搜索且拿到响应，才在结果里标记 searched=true；
网络失败或无结果时返回 failed/空，绝不伪造搜索结果。
"""

import json
import logging
import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.agent_instructions import DATA_BOUNDARY_POLICY, compose_system_prompt
from app.config import get_settings
from app.skills.capability import SkillInvocation
from app.skills.model_helper import create_chat_model, has_api_key

logger = logging.getLogger(__name__)

MAX_RESULTS = 8
HTTP_TIMEOUT = 15.0
SEARCH_SUMMARY_SYSTEM_PROMPT = compose_system_prompt(
    DATA_BOUNDARY_POLICY,
    '''你是夜雨的联网搜索摘要模块。只根据本次检索结果，用中文简明回答用户问题，并在相关句末用 [序号] 标注来源。区分网页明确陈述与自己的推断；结果不足、相互冲突或时效不明时如实说明。不要编造未出现在结果中的事实、来源或已经执行的操作，不展示隐藏推理。''',
)


def _extract_query(invocation: SkillInvocation) -> str:
    payload = invocation.payload or {}
    for key in ('query', 'q', 'keyword'):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:200]
    text = (invocation.instruction or '').strip()
    text = re.sub(r'^(搜一下|搜索一下|联网搜索|查一下|帮我查|搜搜)\s*', '', text)
    return text[:200]


def _decode_ddg_url(href: str) -> str:
    if href.startswith('//'):
        href = 'https:' + href
    parsed = urlparse(href)
    if 'duckduckgo.com' in parsed.netloc and parsed.query:
        qs = parse_qs(parsed.query)
        uddg = qs.get('uddg', [None])[0]
        if uddg:
            return unquote(uddg)
    return href


def _parse_ddg_html(html: str) -> list[dict[str, str]]:
    """容忍式解析 DuckDuckGo 的 lite / html 两种结果页。

    lite 页用 class='result-link' 且 href 为直链；html 页用 class="result__a"
    且 href 为 uddg 跳转。这里不依赖属性顺序与引号风格，统一提取。
    """
    results: list[dict[str, str]] = []
    for match in re.finditer(r'<a\b([^>]*)>(.*?)</a>', html, re.S):
        attrs, inner = match.group(1), match.group(2)
        if 'result-link' not in attrs and 'result__a' not in attrs:
            continue
        href_match = re.search(r'''href=["']([^"']+)["']''', attrs)
        if not href_match:
            continue
        url = _decode_ddg_url(href_match.group(1))
        title = re.sub(r'<[^>]+>', '', inner).strip()
        if title and url:
            results.append({'title': title, 'url': url, 'snippet': ''})
    snippets: list[str] = []
    for match in re.finditer(r'<td\b([^>]*)>(.*?)</td>', html, re.S):
        if 'result-snippet' in match.group(1) or 'result__snippet' in match.group(1):
            snippets.append(re.sub(r'<[^>]+>', '', match.group(2)).strip())
    for index, snippet in enumerate(snippets):
        if index < len(results):
            results[index]['snippet'] = snippet
    return results[:MAX_RESULTS]


def _search_tavily(query: str, api_key: str) -> tuple[list[dict[str, str]], str | None]:
    response = httpx.post(
        'https://api.tavily.com/search',
        json={'api_key': api_key, 'query': query, 'max_results': MAX_RESULTS, 'include_answer': True},
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()
    results = [
        {'title': item.get('title', ''), 'url': item.get('url', ''), 'snippet': (item.get('content') or '')[:500]}
        for item in (data.get('results') or [])[:MAX_RESULTS]
    ]
    return results, data.get('answer')


def _search_ddg(query: str) -> list[dict[str, str]]:
    response = httpx.post(
        'https://lite.duckduckgo.com/lite/',
        data={'q': query, 'kl': 'cn-zh'},
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
        timeout=HTTP_TIMEOUT,
        follow_redirects=True,
    )
    response.raise_for_status()
    return _parse_ddg_html(response.text)


def _summarize(query: str, results: list[dict[str, str]], invocation: SkillInvocation) -> str | None:
    if not results or not has_api_key(invocation.model_config_override, get_settings()):
        return None
    context = '\n\n'.join(f"[{i + 1}] {item['title']}\n{item['url']}\n{item['snippet']}" for i, item in enumerate(results[:6]))
    try:
        model = create_chat_model(invocation.model_config_override, get_settings(), default_temperature=0.2)
        reply = model.invoke([
            ('system', SEARCH_SUMMARY_SYSTEM_PROMPT),
            ('human', f'问题：{query}\n\n检索结果：\n{context}'),
        ])
        return str(reply.content).strip()
    except Exception:
        logger.exception('search summarize failed')
        return None


def execute_search_skill(invocation: SkillInvocation) -> dict[str, Any]:
    query = _extract_query(invocation)
    if not query:
        return {'status': 'needs_input', 'message': '请说明要搜索的关键词或问题。', 'searched': False}

    settings = get_settings()
    tavily_key = settings.tavily_api_key or (invocation.payload or {}).get('tavily_api_key')
    try:
        if tavily_key:
            results, answer = _search_tavily(query, str(tavily_key))
        else:
            results = _search_ddg(query)
            answer = None
    except Exception as error:
        logger.warning('web search failed: %s', error)
        return {
            'status': 'failed',
            'message': '联网搜索失败，可能是网络受限或搜索服务不可用。可稍后重试，或在设置中配置 TAVILY_API_KEY。',
            'query': query,
            'results': [],
            'searched': False,
        }

    summary = answer or _summarize(query, results, invocation)
    return {
        'status': 'completed',
        'message': summary or (f'已检索到 {len(results)} 条结果。' if results else '未检索到相关结果。'),
        'query': query,
        'results': results,
        'summary': summary,
        'searched': True,
        'provider': 'tavily' if tavily_key else 'duckduckgo',
    }

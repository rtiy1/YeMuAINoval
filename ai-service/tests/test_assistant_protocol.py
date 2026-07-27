import os
import sys
import unittest
from pathlib import Path
from unittest import mock

service_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(service_root))
os.environ.setdefault('AI_SERVICE_TOKEN', 'test-token')

from app.config import Settings
from app.schemas import EditProposal, StoryMemoryCandidate, StoryMemoryExtractRequest, ModelConfig
from app.skills.model_helper import has_api_key, resolve_model_kwargs
from app.skills.capability import SkillInvocation
from app.workflows.assistant_agent import ASSISTANT_SYSTEM_PROMPT, _fallback_decision
from app.schemas import WritingAssistantTurnRequest
from app.workflows.memory import extract_story_memories


class AssistantProtocolTests(unittest.TestCase):
    def test_prompt_contains_persona_fact_priority_and_execution_boundary(self):
        self.assertIn('克制、敏锐', ASSISTANT_SYSTEM_PROMPT)
        self.assertIn('作品事实优先级', ASSISTANT_SYSTEM_PROMPT)
        self.assertIn('尚未修改正文', ASSISTANT_SYSTEM_PROMPT)
        self.assertIn('最多提出 2 个', ASSISTANT_SYSTEM_PROMPT)

    def test_fallback_asks_at_most_one_question(self):
        decision = _fallback_decision(WritingAssistantTurnRequest(message='我想写一本小说'), 'story')
        self.assertLessEqual(len(decision.questions), 2)

    def test_explicit_memory_and_edit_schemas(self):
        candidate = StoryMemoryCandidate(type='canon_fact', title='身份', content='她是记者。', reason='正文明确说明。')
        self.assertEqual(candidate.importance, 3)
        proposal = EditProposal(revised_text='新正文', summary='调整表达', blocks=[{'original': '旧', 'replacement': '新', 'reason': '更准确'}])
        self.assertEqual(proposal.blocks[0].reason, '更准确')

    def test_memory_extraction_requires_model(self):
        response = extract_story_memories(StoryMemoryExtractRequest(chapter_title='第一章', content='她推开门。', writing_context={}))
        self.assertEqual(response.status, 'needs_model')
        self.assertEqual(response.candidates, [])

    def test_web_search_toggle_bypasses_planning_and_uses_results(self):
        from app.workflows.assistant_agent import run_writing_assistant_turn
        request = WritingAssistantTurnRequest(message='最近悬疑短篇有什么趋势？', web_search=True)
        fake = {'status': 'completed', 'results': [{'title': '盐言故事榜', 'url': 'https://example.com/a', 'snippet': '...'}], 'summary': None, 'searched': True, 'message': '已检索到 1 条结果。'}
        with mock.patch('app.skills.search.execute_search_skill', return_value=fake):
            response = run_writing_assistant_turn(request)
        self.assertEqual(response.status, 'completed')
        self.assertEqual(response.selected_skill, 'story-search')
        self.assertEqual(response.route, 'web-search')
        self.assertIn('盐言故事榜', response.reply)
        self.assertIsNone(response.proposal)

    def test_web_search_toggle_reports_failure_honestly(self):
        from app.workflows.assistant_agent import run_writing_assistant_turn
        request = WritingAssistantTurnRequest(message='搜一下 不存在的词', web_search=True)
        with mock.patch('app.skills.search.execute_search_skill', return_value={'status': 'failed', 'results': [], 'message': '联网搜索失败。', 'searched': False}):
            response = run_writing_assistant_turn(request)
        self.assertEqual(response.status, 'completed')
        self.assertIn('失败', response.reply)

    def test_anthropic_kwargs_default_max_tokens_and_base_url(self):
        kwargs = resolve_model_kwargs(ModelConfig(provider='anthropic', model='claude-3-5-sonnet-latest', api_key='k', api_base_url='https://proxy.example/v1'), get_settings := __import__('app.config', fromlist=['get_settings']).get_settings())
        self.assertEqual(kwargs['provider'], 'anthropic')
        self.assertEqual(kwargs['max_tokens'], 4096)
        self.assertEqual(kwargs['anthropic_api_url'], 'https://proxy.example/v1')
        self.assertNotIn('base_url', kwargs)

    def test_openai_kwargs_unchanged(self):
        kwargs = resolve_model_kwargs(ModelConfig(provider='openai', model='gpt-4o-mini', api_key='k', max_tokens=1024), __import__('app.config', fromlist=['get_settings']).get_settings())
        self.assertEqual(kwargs['provider'], 'openai')
        self.assertEqual(kwargs['max_tokens'], 1024)
        self.assertNotIn('anthropic_api_url', kwargs)

    def test_strict_byok_ignores_server_keys_but_accepts_user_key(self):
        settings = Settings(openai_api_key='server-openai', anthropic_api_key='server-anthropic')
        for provider in ('openai', 'anthropic'):
            without_user_key = ModelConfig(provider=provider, allow_server_fallback=False)
            self.assertFalse(has_api_key(without_user_key, settings))
            self.assertIsNone(resolve_model_kwargs(without_user_key, settings)['api_key'])

            with_user_key = ModelConfig(provider=provider, api_key=f'user-{provider}', allow_server_fallback=False)
            self.assertTrue(has_api_key(with_user_key, settings))
            self.assertEqual(resolve_model_kwargs(with_user_key, settings)['api_key'], f'user-{provider}')


class SearchSkillTests(unittest.TestCase):
    def test_search_parses_ddg_html_and_marks_searched(self):
        from app.skills.search import execute_search_skill, _parse_ddg_html
        # DuckDuckGo lite 页：单引号 class、直链、td 摘要
        html = (
            "<a rel='nofollow' href='https://example.com/a' class='result-link'>示例链接</a>"
            "<td class='result-snippet'>这是摘要片段。</td>"
        )
        parsed = _parse_ddg_html(html)
        self.assertEqual(parsed[0]['url'], 'https://example.com/a')
        self.assertEqual(parsed[0]['snippet'], '这是摘要片段。')

        invocation = SkillInvocation(skill_name='story-search', instruction='搜一下 悬疑短篇趋势')
        with mock.patch('app.skills.search._search_ddg', return_value=parsed):
            result = execute_search_skill(invocation)
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['searched'])
        self.assertEqual(result['provider'], 'duckduckgo')
        self.assertEqual(result['results'][0]['title'], '示例链接')

    def test_search_returns_failed_without_faking_results(self):
        from app.skills.search import execute_search_skill
        invocation = SkillInvocation(skill_name='story-search', instruction='搜一下 不存在的词')
        with mock.patch('app.skills.search._search_ddg', side_effect=Exception('network down')):
            result = execute_search_skill(invocation)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['searched'])
        self.assertEqual(result['results'], [])

    def test_search_needs_input_when_no_query(self):
        from app.skills.search import execute_search_skill
        result = execute_search_skill(SkillInvocation(skill_name='story-search', instruction='   '))
        self.assertEqual(result['status'], 'needs_input')
        self.assertFalse(result['searched'])


if __name__ == '__main__':
    unittest.main()

import os
import sys
import unittest
from pathlib import Path

import httpx

service_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(service_root))
os.environ['AI_SERVICE_TOKEN'] = 'test-service-token'

from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.skills.registry import get_skill_registry  # noqa: E402


class ReviewWorkflowTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        get_settings.cache_clear()

    async def asyncSetUp(self):
        transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=transport, base_url='http://testserver')

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_health_reports_skill_capabilities(self):
        response = await self.client.get('/health')
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['ok'])
        self.assertFalse(payload['llm_configured'])
        self.assertEqual(payload['skills_installed'], 13)
        self.assertEqual(payload['skills_ready'], 2)
        self.assertEqual(payload['skills_needing_model'], 9)

    async def test_registry_uses_vendored_project_skills(self):
        self.assertEqual(get_skill_registry().root, service_root.parent / 'skills')
        self.assertTrue((get_skill_registry().root / 'story-review' / 'SKILL.md').is_file())

    async def test_review_requires_internal_token(self):
        response = await self.client.post('/v1/reviews/chapter', json={
            'title': '雨夜', 'genre': '悬疑', 'content': '雨落下来。门从里面反锁。',
        })
        self.assertEqual(response.status_code, 401)

    async def test_skill_catalog_marks_executors(self):
        response = await self.client.get('/v1/skills', headers={'x-service-token': 'test-service-token'})
        self.assertEqual(response.status_code, 200)
        skills = {item['name']: item for item in response.json()['skills']}
        self.assertEqual(skills['story']['status'], 'ready')
        self.assertEqual(skills['story-review']['status'], 'ready')
        self.assertEqual(skills['story-deslop']['status'], 'needs_model')
        self.assertEqual(skills['story-deslop']['executor'], 'deslop-v1')
        self.assertEqual(skills['story-long-write']['executor'], 'prompt-only-v1')
        self.assertEqual(skills['story-cover']['status'], 'registered')

    async def test_agent_invokes_story_review_capability(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={
                'message': '审查这一章',
                'payload': {
                    'title': '雨夜',
                    'genre': '悬疑',
                    'platform': '番茄',
                    'content': '雨落下来。门从里面反锁，但屋里没有人。',
                },
            },
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload['selected_skill'], 'story-review')
        self.assertEqual(payload['route'], 'story-router')
        self.assertEqual(payload['result']['Rubric'], 'fanqie')
        self.assertEqual(payload['result']['Effective Mode'], 'solo')

    async def test_prompt_skill_reports_missing_model_and_loads_references(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={'message': '帮我开书', 'skill': 'story-long-write'},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['status'], 'needs_model')
        self.assertTrue(payload['result']['contract_loaded'])
        # story-long-write SKILL.md 引用了大量 references，应非空
        self.assertIsInstance(payload['result']['references_loaded'], list)
        self.assertGreater(len(payload['result']['references_loaded']), 0)

    async def test_deslop_reports_missing_model_with_checks(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={
                'message': '去 AI 味',
                'skill': 'story-deslop',
                'payload': {'content': '映入眼帘的是一幕场景。他深吸一口气，嘴角勾起一抹弧度。'},
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['status'], 'needs_model')
        self.assertEqual(payload['result']['skill'], 'story-deslop')
        self.assertIsInstance(payload['result']['checks'], list)

    async def test_browser_skill_requires_adapter(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={'message': '打开浏览器', 'skill': 'browser-cdp'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'needs_adapter')

    async def test_reference_path_escape_is_blocked(self):
        registry = get_skill_registry()
        from app.skills.registry import SkillRegistryError
        with self.assertRaises(SkillRegistryError):
            registry.read_reference('story-review', '../../../etc/passwd')
        with self.assertRaises(SkillRegistryError):
            registry.script_path('story-review', '../../../etc/passwd')

    async def test_registry_auto_allows_story_deslop_scripts(self):
        registry = get_skill_registry()
        # story-deslop 的脚本现在应能自动获取路径（不再需要硬编码白名单）
        path = registry.script_path('story-deslop', 'check-ai-patterns.js')
        self.assertTrue(path.is_file())

    async def test_review_maps_skill_findings_and_metadata(self):
        response = await self.client.post(
            '/v1/reviews/chapter',
            headers={'x-service-token': 'test-service-token'},
            json={
                'title': '雨夜',
                'genre': '悬疑',
                'platform': '知乎盐言',
                'content': '他不是冷漠，而是绝望。属于他的反击才刚刚开始。',
            },
        )
        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload['status'], 'completed')
        self.assertEqual(payload['result']['metrics']['characters'], 23)
        self.assertEqual(payload['result']['Requested Mode'], 'full')
        self.assertEqual(payload['result']['Fallback'], 'agent tool unavailable -> solo')
        self.assertEqual(payload['result']['Rubric'], 'zhihu')
        self.assertEqual(payload['result']['Rubric Source'], 'file')
        self.assertGreaterEqual(payload['result']['severity_counts']['S2'], 1)
        self.assertTrue(all(set(item) == {'severity', 'category', 'location', 'evidence', 'issue', 'fix'} for item in payload['result']['findings']))

    async def test_model_config_override_provides_api_key(self):
        """传入 model_config 含 api_key 时，prompt-only skill 不再报 needs_model。"""
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={
                'message': '帮我开书',
                'skill': 'story-long-write',
                'model_config': {
                    'api_key': 'sk-test-fake-key-123456',
                    'model': 'gpt-4o-mini',
                    'base_url': 'http://127.0.0.1:9999',
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        # 有了 api_key 后不再是 needs_model，而是尝试调用（会因假地址失败）
        self.assertNotEqual(payload['status'], 'needs_model')

    async def test_model_config_override_with_invalid_key_still_needs_model(self):
        """不传 model_config 且服务端无 key 时仍是 needs_model。"""
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={'message': '帮我开书', 'skill': 'story-long-write'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'needs_model')


if __name__ == '__main__':
    unittest.main()

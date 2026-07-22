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
        self.assertEqual(skills['story-deslop']['executor'], 'prompt-only-v1')
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

    async def test_prompt_skill_reports_missing_model(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={'message': '去 AI 味', 'skill': 'story-deslop'},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['status'], 'needs_model')
        self.assertTrue(payload['result']['contract_loaded'])

    async def test_browser_skill_requires_adapter(self):
        response = await self.client.post(
            '/v1/agents/story',
            headers={'x-service-token': 'test-service-token'},
            json={'message': '打开浏览器', 'skill': 'browser-cdp'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'needs_adapter')

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


if __name__ == '__main__':
    unittest.main()

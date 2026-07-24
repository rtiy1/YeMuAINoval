import os
import sys
import unittest
from pathlib import Path

service_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(service_root))
os.environ.setdefault('AI_SERVICE_TOKEN', 'test-token')

from app.schemas import EditProposal, StoryMemoryCandidate, StoryMemoryExtractRequest
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


if __name__ == '__main__':
    unittest.main()

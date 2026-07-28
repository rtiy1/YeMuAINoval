import os
import sys
import unittest
from pathlib import Path


service_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(service_root))
os.environ.setdefault('AI_SERVICE_TOKEN', 'test-token')

from app.model_content import model_content_text, strip_hidden_reasoning_text


class ModelContentTests(unittest.TestCase):
    def test_plain_text_is_unchanged(self):
        self.assertEqual(model_content_text(' 正文 '), '正文')

    def test_anthropic_content_blocks_are_joined(self):
        blocks = [
            {'type': 'text', 'text': '第一段'},
            {'type': 'text', 'text': '第二段'},
        ]
        self.assertEqual(model_content_text(blocks), '第一段\n第二段')

    def test_nested_content_object_uses_text(self):
        self.assertEqual(model_content_text({'content': [{'text': '模型错误'}]}), '模型错误')

    def test_inline_thinking_tags_are_not_exposed_as_output(self):
        self.assertEqual(
            model_content_text('<think>先分析用户意图</think>\n这是给用户的回答。'),
            '这是给用户的回答。',
        )
        self.assertEqual(
            strip_hidden_reasoning_text('开头<analysis>内部判断</analysis>结尾'),
            '开头结尾',
        )

    def test_unclosed_thinking_tag_discards_private_tail(self):
        self.assertEqual(
            model_content_text('可见内容\n<thinking>仍在内部推演'),
            '可见内容',
        )


if __name__ == '__main__':
    unittest.main()

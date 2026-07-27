import os
import sys
import unittest
from pathlib import Path


service_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(service_root))
os.environ.setdefault('AI_SERVICE_TOKEN', 'test-token')

from app.model_content import model_content_text


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


if __name__ == '__main__':
    unittest.main()

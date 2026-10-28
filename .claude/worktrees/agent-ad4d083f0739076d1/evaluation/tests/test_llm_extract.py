import unittest

from evaluation.llm import ModelOutputError, _extract_json


class ExtractJsonTests(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(_extract_json('{"a": 1}'), {"a": 1})

    def test_surrounded(self):
        self.assertEqual(_extract_json('说明如下 {"a": 1} 结束'), {"a": 1})

    def test_fenced(self):
        text = "```json\n{\"b\": 2}\n```"
        self.assertEqual(_extract_json(text), {"b": 2})

    def test_nested(self):
        self.assertEqual(_extract_json('x {"a": {"b": [1,2]}} y'), {"a": {"b": [1, 2]}})

    def test_braces_in_string(self):
        self.assertEqual(_extract_json('{"a": "} {"}'), {"a": "} {"})

    def test_missing(self):
        with self.assertRaises(ModelOutputError):
            _extract_json("没有 JSON")


if __name__ == "__main__":
    unittest.main()

import unittest

from evaluation.analysis import wilson, ratio
from evaluation.dataset import CASES, document_refs_for_families
from evaluation.facts import version_policy_for
from evaluation.grading import aggregate, rule_retrieval, sentence_spans


class AggregateTests(unittest.TestCase):
    def test_not_applicable(self):
        result = aggregate("citation", [], applicable=False)
        self.assertEqual(result["verdict"], "not_applicable")

    def test_fail_beats_unknown(self):
        checks = [
            {"check_id": "a", "status": "unknown", "required": True},
            {"check_id": "b", "status": "fail", "required": True, "severity": "major"},
        ]
        result = aggregate("fact_correctness", checks)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["severity"], "major")

    def test_unknown_when_required_unknown(self):
        checks = [{"check_id": "a", "status": "unknown", "required": True}]
        self.assertEqual(aggregate("completeness", checks)["verdict"], "unknown")

    def test_pass_when_all_required_pass(self):
        checks = [{"check_id": "a", "status": "pass", "required": True}]
        self.assertEqual(aggregate("behavior", checks)["verdict"], "pass")

    def test_empty_checks_is_unknown(self):
        self.assertEqual(aggregate("faithfulness", [])["verdict"], "unknown")

    def test_optional_fail_does_not_fail(self):
        checks = [
            {"check_id": "a", "status": "pass", "required": True},
            {"check_id": "b", "status": "fail", "required": False},
        ]
        self.assertEqual(aggregate("citation", checks)["verdict"], "pass")


class SentenceSpanTests(unittest.TestCase):
    def test_split(self):
        text = "第一句。第二句！第三句"
        spans = sentence_spans(text)
        self.assertEqual(len(spans), 3)
        self.assertEqual(text[spans[0][0]:spans[0][1]], "第一句。")
        self.assertEqual(text[spans[2][0]:spans[2][1]], "第三句")

    def test_newline_terminates(self):
        self.assertEqual(len(sentence_spans("a\nb")), 2)


class RuleRetrievalTests(unittest.TestCase):
    def _case(self, texts):
        return {
            "required_fact_ids": ["P2-PAY-02"],
            "turns": [{"retrieval_stages": {"rerank": [
                {"text": text} for text in texts
            ]}}],
        }

    def test_set_coverage_across_candidates(self):
        case = self._case(["预付款不得超过合同金额的", "30% 且必须提供同等金额的银行保函"])
        result = rule_retrieval(case)
        self.assertEqual(result["stages"]["rerank"]["hits"], 1)
        self.assertEqual(result["stages"]["rerank"]["single_hits"], 0)
        self.assertEqual(result["stages"]["rerank"]["recall"], 1.0)

    def test_single_candidate_hit(self):
        case = self._case(["预付款不得超过合同金额的30%，且必须提供同等金额的银行保函。"])
        entry = rule_retrieval(case)["stages"]["rerank"]
        self.assertEqual(entry["hits"], 1)
        self.assertEqual(entry["single_hits"], 1)

    def test_miss(self):
        case = self._case(["完全无关的文本"])
        entry = rule_retrieval(case)["stages"]["rerank"]
        self.assertEqual(entry["recall"], 0.0)
        self.assertEqual(entry["missing"], ["P2-PAY-02"])


class PolicyAndDatasetTests(unittest.TestCase):
    def test_version_policy_by_family(self):
        self.assertEqual(version_policy_for(["procurement_payment"])["policy_ref"], "policy:procurement_revision")
        self.assertEqual(version_policy_for(["leave_attendance"])["policy_ref"], "policy:leave_attendance_revision")
        self.assertIsNone(version_policy_for(["unknown_family"]))

    def test_case_families_are_families_not_refs(self):
        by_id = {case.case_id: case for case in CASES}
        self.assertEqual(by_id["DM-E-01"].document_families, ["procurement_payment"])
        self.assertEqual(by_id["DM-T-01"].document_families, ["travel_expense"])

    def test_document_refs_for_families(self):
        refs = document_refs_for_families(["procurement_payment"])
        self.assertEqual(refs, {"procurement_v1", "procurement_v2"})

    def test_behavior_cases_have_legal_variants(self):
        for case in CASES:
            if not case.required_fact_ids:
                self.assertTrue(case.legal_variants, case.case_id)


class IntervalTests(unittest.TestCase):
    def test_ratio_zero_denominator(self):
        self.assertIsNone(ratio(0, 0))

    def test_wilson_bounds(self):
        low, high = wilson(12, 19)
        self.assertLess(low, 12 / 19)
        self.assertGreater(high, 12 / 19)
        self.assertGreaterEqual(low, 0.0)
        self.assertLessEqual(high, 1.0)


if __name__ == "__main__":
    unittest.main()

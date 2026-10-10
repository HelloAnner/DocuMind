"""D03 标准事实：受控语料的事实真值、版本规则与证据条款。

事实先由程序按制度文本确定，再渲染原文件；核验原文件确实包含这些事实。
每条事实保存主体/谓词/值/单位/条件/例外、源文档与必要条件词。
必要条件词用于 D04 保留核验：去掉空白后必须能在解析产物中找到。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Fact:
    fact_id: str
    statement: str
    document_ref: str
    revision: str
    fact_type: str = "scalar"
    conditions: list[str] = field(default_factory=list)
    exceptions: list[str] = field(default_factory=list)
    scope: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None
    authority: str | None = None
    required_terms: list[str] = field(default_factory=list)
    forbidden_terms: list[str] = field(default_factory=list)
    confirmation: str = "program-controlled-corpus-v1"

    def as_dict(self) -> dict[str, Any]:
        return {
            "fact_id": self.fact_id,
            "statement": self.statement,
            "document_ref": self.document_ref,
            "revision": self.revision,
            "fact_type": self.fact_type,
            "conditions": list(self.conditions),
            "exceptions": list(self.exceptions),
            "scope": self.scope,
            "effective_from": self.effective_from,
            "effective_to": self.effective_to,
            "authority": self.authority,
            "required_terms": list(self.required_terms),
            "forbidden_terms": list(self.forbidden_terms),
            "confirmation_ref": self.confirmation,
            "source_refs": [f"{self.document_ref}#{self.fact_id}"],
        }


VERSION_POLICY: dict[str, Any] = {
    "policy_ref": "policy:procurement_revision",
    "effective_at": "2026-10-01",
    "rules": [
        "《采购与付款管理制度（2026 版）》自 2026-07-01 施行，同时废止 2024 版。",
        "评估基准日 2026-10-01 时，采购与付款以 2026 版为唯一有效版本。",
        "2024 版内容仅作为历史资料，不能作为当前有效答案。",
    ],
    "replaces": {"procurement_v2": ["procurement_v1"]},
}

# 每个文档族的版本政策：只有采购与付款存在新旧冲突，其余为单版本有效。
VERSION_POLICIES: dict[str, dict[str, Any]] = {
    "procurement_payment": VERSION_POLICY,
    "travel_expense": {
        "policy_ref": "policy:travel_expense_revision",
        "effective_at": "2026-10-01",
        "rules": [
            "《员工差旅报销标准（2026 修订）》自 2026-04-01 施行，评估基准日仍为唯一有效版本。",
            "该文档族不存在并行或冲突版本，按 2026 修订版作答。",
        ],
        "replaces": {},
    },
    "leave_attendance": {
        "policy_ref": "policy:leave_attendance_revision",
        "effective_at": "2026-10-01",
        "rules": [
            "《员工请假与考勤制度（2026 版）》自 2026-01-01 施行，评估基准日仍为唯一有效版本。",
            "该文档族不存在并行或冲突版本，按 2026 版作答。",
        ],
        "replaces": {},
    },
    "contract_approval": {
        "policy_ref": "policy:contract_approval_revision",
        "effective_at": "2026-10-01",
        "rules": [
            "《客户合同审批权限规定（2026 版）》自 2026-02-01 施行，评估基准日仍为唯一有效版本。",
            "该文档族不存在并行或冲突版本，按 2026 版作答。",
        ],
        "replaces": {},
    },
}


def version_policy_for(document_families: list[str]) -> dict[str, Any] | None:
    """按文档族返回适用的版本政策；无匹配时返回 None，不硬套采购政策。"""
    for family in document_families:
        if family in VERSION_POLICIES:
            return VERSION_POLICIES[family]
    return None


FACTS: list[Fact] = [
    # ---------------------------------------------------------- 采购与付款 2026 版
    Fact(
        fact_id="P2-SCOPE-01",
        statement="本制度适用于集团及各子公司单笔金额 5 万元以上的采购活动。",
        document_ref="procurement_v2", revision="2026版", fact_type="scalar",
        scope="单笔金额 5 万元以上", effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["适用于集团及各子公司", "5万元以上的采购活动"],
    ),
    Fact(
        fact_id="P2-SCOPE-02",
        statement="单笔 5 万元以下的小额采购按《小额采购细则》执行，不适用本制度付款审批流程。",
        document_ref="procurement_v2", revision="2026版", fact_type="exception",
        scope="单笔 5 万元以下", effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["小额采购细则", "不适用本制度付款审批流程"],
    ),
    Fact(
        fact_id="P2-PAY-01",
        statement="标准付款条件为验收合格后 30 日内支付合同金额的 90%，剩余 10% 作为质保金，在质保期满且无质量异议后 15 日内支付。",
        document_ref="procurement_v2", revision="2026版", fact_type="scalar",
        effective_from="2026-07-01", authority="集团财务中心",
        required_terms=["验收合格后30日内", "90%", "10%", "质保期满且无质量异议后15日内"],
    ),
    Fact(
        fact_id="P2-PAY-02",
        statement="预付款不得超过合同金额的 30%，且必须提供同等金额的银行保函。",
        document_ref="procurement_v2", revision="2026版", fact_type="condition",
        conditions=["提供同等金额的银行保函"], effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["预付款不得超过合同金额的30%", "银行保函"],
    ),
    Fact(
        fact_id="P2-PAY-03",
        statement="付款阶段表：预付款不超过 30% 且需同等金额银行保函；验收款为 90%，验收合格后 30 日内；质保金为 10%，质保期满且无质量异议后 15 日内。",
        document_ref="procurement_v2", revision="2026版", fact_type="table_relation",
        effective_from="2026-07-01", authority="集团财务中心",
        required_terms=["付款阶段", "预付款", "不超过30%", "验收款", "90%", "质保金", "10%", "质保期满且无质量异议后15日内"],
    ),
    Fact(
        fact_id="P2-APPR-01",
        statement="单笔采购金额 5 万元（含）至 50 万元，由采购部负责人审批。",
        document_ref="procurement_v2", revision="2026版", fact_type="scalar",
        scope="5 万元（含）至 50 万元", effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["5万元（含）至50万元", "采购部负责人审批"],
    ),
    Fact(
        fact_id="P2-APPR-02",
        statement="单笔采购金额 50 万元（含）至 200 万元，由分管副总裁审批。",
        document_ref="procurement_v2", revision="2026版", fact_type="scalar",
        scope="50 万元（含）至 200 万元", effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["50万元（含）至200万元", "分管副总裁审批"],
    ),
    Fact(
        fact_id="P2-APPR-03",
        statement="单笔采购金额 200 万元（含）以上，须经集团总裁办公会审议。",
        document_ref="procurement_v2", revision="2026版", fact_type="scalar",
        scope="200 万元（含）以上", effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["200万元（含）以上", "集团总裁办公会审议"],
    ),
    Fact(
        fact_id="P2-EXC-01",
        statement="涉及抢险救灾、安全生产的紧急采购，可先执行后补办审批手续，但应在 3 个工作日内补齐。",
        document_ref="procurement_v2", revision="2026版", fact_type="exception",
        conditions=["抢险救灾、安全生产的紧急采购"], effective_from="2026-07-01",
        authority="集团财务中心",
        required_terms=["抢险救灾、安全生产", "先执行后补办审批手续", "3个工作日内补齐"],
    ),
    Fact(
        fact_id="P2-PROH-01",
        statement="严禁将单笔采购拆分为多笔以规避审批权限。",
        document_ref="procurement_v2", revision="2026版", fact_type="negation",
        effective_from="2026-07-01", authority="集团财务中心",
        required_terms=["严禁将单笔采购拆分为多笔", "规避审批权限"],
    ),
    Fact(
        fact_id="P2-EFF-01",
        statement="本制度自 2026 年 7 月 1 日起施行，原《采购与付款管理制度（2024 版）》同时废止。",
        document_ref="procurement_v2", revision="2026版", fact_type="version_rule",
        effective_from="2026-07-01", authority="集团财务中心",
        required_terms=["2026年7月1日起施行", "2024版", "同时废止"],
    ),
    # ---------------------------------------------------------- 采购与付款 2024 版（历史）
    Fact(
        fact_id="P1-PAY-01",
        statement="（2024 版历史条款）验收合格后 60 日内一次性支付合同金额的 95%，剩余 5% 作为质保金，质保期满后 30 日内支付。",
        document_ref="procurement_v1", revision="2024版", fact_type="version_rule",
        effective_from="2024-01-01", effective_to="2026-06-30", authority="集团财务中心",
        required_terms=["60日内一次性支付", "95%", "5%", "质保期满后30日内支付"],
    ),
    Fact(
        fact_id="P1-PAY-02",
        statement="（2024 版历史条款）预付款不得超过合同金额的 50%。",
        document_ref="procurement_v1", revision="2024版", fact_type="version_rule",
        effective_from="2024-01-01", effective_to="2026-06-30", authority="集团财务中心",
        required_terms=["预付款不得超过合同金额的50%"],
    ),
    Fact(
        fact_id="P1-APPR-01",
        statement="（2024 版历史条款）单笔采购金额 5 万元（含）至 100 万元，由采购部负责人审批。",
        document_ref="procurement_v1", revision="2024版", fact_type="version_rule",
        effective_from="2024-01-01", effective_to="2026-06-30", authority="集团财务中心",
        required_terms=["5万元（含）至100万元", "采购部负责人审批"],
    ),
    Fact(
        fact_id="P1-APPR-02",
        statement="（2024 版历史条款）单笔采购金额 100 万元（含）以上，由分管副总裁审批。",
        document_ref="procurement_v1", revision="2024版", fact_type="version_rule",
        effective_from="2024-01-01", effective_to="2026-06-30", authority="集团财务中心",
        required_terms=["100万元（含）以上", "分管副总裁审批"],
    ),
    # ---------------------------------------------------------- 差旅报销 2026 修订
    Fact(
        fact_id="T-LODGE-01",
        statement="住宿标准表：一线城市每晚上限 600 元，二线城市 400 元，其他城市 300 元。",
        document_ref="travel_standard", revision="2026修订", fact_type="table_relation",
        effective_from="2026-04-01", authority="集团人力资源中心",
        required_terms=["一线城市", "600", "二线城市", "400", "其他城市", "300"],
    ),
    Fact(
        fact_id="T-TRAFFIC-01",
        statement="市内交通费实报实销，每日不超过 100 元。",
        document_ref="travel_standard", revision="2026修订", fact_type="scalar",
        effective_from="2026-04-01", authority="集团人力资源中心",
        required_terms=["市内交通费实报实销", "每日不超过100元"],
    ),
    Fact(
        fact_id="T-TRAFFIC-02",
        statement="跨城高铁行程超过 4 小时的，可乘坐一等座。",
        document_ref="travel_standard", revision="2026修订", fact_type="condition",
        conditions=["跨城高铁行程超过 4 小时"], effective_from="2026-04-01",
        authority="集团人力资源中心",
        required_terms=["超过4小时的", "一等座"],
    ),
    Fact(
        fact_id="T-CLAIM-01",
        statement="员工应在出差结束后 15 个工作日内提交报销单；逾期超过 30 个工作日的，需财务总监特批。",
        document_ref="travel_standard", revision="2026修订", fact_type="scalar",
        effective_from="2026-04-01", authority="集团人力资源中心",
        required_terms=["出差结束后15个工作日内提交报销单", "逾期超过30个工作日", "财务总监特批"],
    ),
    Fact(
        fact_id="T-CLAIM-02",
        statement="因项目紧急需延长出差的，经项目经理书面确认后不受 15 个工作日限制。",
        document_ref="travel_standard", revision="2026修订", fact_type="exception",
        conditions=["项目紧急需延长出差", "项目经理书面确认"], effective_from="2026-04-01",
        authority="集团人力资源中心",
        required_terms=["项目紧急需延长出差", "项目经理书面确认", "不受15个工作日限制"],
    ),
    # ---------------------------------------------------------- 请假与考勤
    Fact(
        fact_id="L-ANNUAL-01",
        statement="年假：入职满 1 年享 5 天，满 3 年享 10 天，满 5 年享 15 天。",
        document_ref="leave_attendance", revision="2026版", fact_type="table_relation",
        effective_from="2026-01-01", authority="集团人力资源中心",
        required_terms=["满1年享5天", "满3年享10天", "满5年享15天"],
    ),
    Fact(
        fact_id="L-SICK-01",
        statement="连续病假超过 3 天的，须提供二级以上医院证明。",
        document_ref="leave_attendance", revision="2026版", fact_type="condition",
        conditions=["连续病假超过 3 天"], effective_from="2026-01-01",
        authority="集团人力资源中心",
        required_terms=["连续病假超过3天", "二级以上医院证明"],
    ),
    Fact(
        fact_id="L-PERSONAL-01",
        statement="事假全年累计不得超过 15 天，超过部分不计发工资。",
        document_ref="leave_attendance", revision="2026版", fact_type="scalar",
        effective_from="2026-01-01", authority="集团人力资源中心",
        required_terms=["全年累计不得超过15天", "超过部分不计发工资"],
    ),
    Fact(
        fact_id="L-APPR-01",
        statement="请假 3 天（含）以内由直属主管审批；3 天以上至 7 天由部门负责人审批；7 天以上由人力资源总监审批。",
        document_ref="leave_attendance", revision="2026版", fact_type="table_relation",
        effective_from="2026-01-01", authority="集团人力资源中心",
        required_terms=["3天（含）以内由直属主管审批", "3天以上至7天由部门负责人审批", "7天以上由人力资源总监审批"],
    ),
    # ---------------------------------------------------------- 合同审批权限
    Fact(
        fact_id="C-APPR-01",
        statement="合同金额 100 万元以下，由销售总监审批。",
        document_ref="contract_approval", revision="2026版", fact_type="scalar",
        scope="100 万元以下", effective_from="2026-02-01", authority="集团法务与销售中心",
        required_terms=["合同金额100万元以下", "销售总监审批"],
    ),
    Fact(
        fact_id="C-APPR-02",
        statement="合同金额 100 万元（含）至 500 万元，由分管副总裁审批。",
        document_ref="contract_approval", revision="2026版", fact_type="scalar",
        scope="100 万元（含）至 500 万元", effective_from="2026-02-01",
        authority="集团法务与销售中心",
        required_terms=["100万元（含）至500万元", "分管副总裁审批"],
    ),
    Fact(
        fact_id="C-APPR-03",
        statement="合同金额 500 万元（含）以上，须经总经理批准。",
        document_ref="contract_approval", revision="2026版", fact_type="scalar",
        scope="500 万元（含）以上", effective_from="2026-02-01",
        authority="集团法务与销售中心",
        required_terms=["500万元（含）以上", "总经理批准"],
    ),
    Fact(
        fact_id="C-SPECIAL-01",
        statement="涉及排他条款、无上限赔偿或超过 2 年账期的合同，无论金额大小均须法务与总经理共同审批。",
        document_ref="contract_approval", revision="2026版", fact_type="condition",
        conditions=["排他条款、无上限赔偿或超过 2 年账期"], effective_from="2026-02-01",
        authority="集团法务与销售中心",
        required_terms=["排他条款、无上限赔偿或超过2年账期", "法务与总经理共同审批"],
    ),
    Fact(
        fact_id="C-PROH-01",
        statement="禁止先签约后审批。",
        document_ref="contract_approval", revision="2026版", fact_type="negation",
        effective_from="2026-02-01", authority="集团法务与销售中心",
        required_terms=["禁止先签约后审批"],
    ),
]

FACT_BY_ID: dict[str, Fact] = {fact.fact_id: fact for fact in FACTS}

# 当前有效版本事实（评估基准日 2026-10-01）
EFFECTIVE_FACTS: list[Fact] = [
    fact for fact in FACTS
    if fact.document_ref != "procurement_v1"
]

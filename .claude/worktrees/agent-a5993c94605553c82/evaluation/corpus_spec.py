"""D03 受控语料与标准事实：程序先定事实，再渲染真实格式文件并核验。

固定种子与固定内容；所有生成文件只写 R，不写源码 data 目录。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .core import RunContext, sha256_file, sha256_text, utc_iso


def normalize(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


@dataclass
class DocSpec:
    document_ref: str
    document_family: str
    revision: str
    published_at: str | None
    effective_from: str | None
    effective_to: str | None
    authority: str
    file_name: str
    file_type: str
    title: str
    blocks: list[dict[str, Any]] = field(default_factory=list)


PROCUREMENT_V2 = DocSpec(
    document_ref="procurement_v2",
    document_family="procurement_payment",
    revision="2026版",
    published_at="2026-06-20",
    effective_from="2026-07-01",
    effective_to=None,
    authority="集团财务中心",
    file_name="procurement-payment-policy-2026.docx",
    file_type="docx",
    title="采购与付款管理制度（2026 版）",
    blocks=[
        {"type": "heading", "level": 1, "text": "一、适用范围"},
        {"type": "paragraph", "text": "本制度适用于集团及各子公司单笔金额 5 万元以上的采购活动。"},
        {"type": "paragraph", "text": "单笔 5 万元以下的小额采购按《小额采购细则》执行，不适用本制度付款审批流程。"},
        {"type": "heading", "level": 1, "text": "二、付款条件"},
        {"type": "paragraph", "text": "标准付款条件为验收合格后 30 日内支付合同金额的 90%，剩余 10% 作为质保金，在质保期满且无质量异议后 15 日内支付。"},
        {"type": "paragraph", "text": "预付款不得超过合同金额的 30%，且必须提供同等金额的银行保函。"},
        {"type": "heading", "level": 1, "text": "三、付款阶段"},
        {"type": "table", "header": ["付款阶段", "比例", "触发条件"],
         "rows": [
             ["预付款", "不超过 30%", "提供同等金额银行保函"],
             ["验收款", "90%", "验收合格后 30 日内"],
             ["质保金", "10%", "质保期满且无质量异议后 15 日内"],
         ]},
        {"type": "heading", "level": 1, "text": "四、审批权限"},
        {"type": "paragraph", "text": "单笔采购金额 5 万元（含）至 50 万元，由采购部负责人审批。"},
        {"type": "paragraph", "text": "单笔采购金额 50 万元（含）至 200 万元，由分管副总裁审批。"},
        {"type": "paragraph", "text": "单笔采购金额 200 万元（含）以上，须经集团总裁办公会审议。"},
        {"type": "heading", "level": 1, "text": "五、例外情形"},
        {"type": "paragraph", "text": "涉及抢险救灾、安全生产的紧急采购，可先执行后补办审批手续，但应在 3 个工作日内补齐。"},
        {"type": "heading", "level": 1, "text": "六、禁止事项"},
        {"type": "paragraph", "text": "严禁将单笔采购拆分为多笔以规避审批权限。"},
        {"type": "heading", "level": 1, "text": "七、生效与废止"},
        {"type": "paragraph", "text": "本制度自 2026 年 7 月 1 日起施行，原《采购与付款管理制度（2024 版）》同时废止。"},
    ],
)

PROCUREMENT_V1 = DocSpec(
    document_ref="procurement_v1",
    document_family="procurement_payment",
    revision="2024版",
    published_at="2023-12-15",
    effective_from="2024-01-01",
    effective_to="2026-06-30",
    authority="集团财务中心",
    file_name="procurement-payment-policy-2024.pdf",
    file_type="pdf",
    title="采购与付款管理制度（2024 版）",
    blocks=[
        {"type": "heading", "level": 1, "text": "一、付款条件"},
        {"type": "paragraph", "text": "验收合格后 60 日内一次性支付合同金额的 95%，剩余 5% 作为质保金，质保期满后 30 日内支付。"},
        {"type": "paragraph", "text": "预付款不得超过合同金额的 50%。"},
        {"type": "heading", "level": 1, "text": "二、审批权限"},
        {"type": "paragraph", "text": "单笔采购金额 5 万元（含）至 100 万元，由采购部负责人审批。"},
        {"type": "paragraph", "text": "单笔采购金额 100 万元（含）以上，由分管副总裁审批。"},
        {"type": "heading", "level": 1, "text": "三、生效"},
        {"type": "paragraph", "text": "本制度自 2024 年 1 月 1 日起施行。"},
    ],
)

TRAVEL_PPTX = DocSpec(
    document_ref="travel_standard",
    document_family="travel_expense",
    revision="2026修订",
    published_at="2026-03-10",
    effective_from="2026-04-01",
    effective_to=None,
    authority="集团人力资源中心",
    file_name="travel-expense-standard-2026.pptx",
    file_type="pptx",
    title="员工差旅报销标准（2026 修订）",
    blocks=[
        {"type": "heading", "level": 1, "text": "住宿标准"},
        {"type": "table", "header": ["城市等级", "每晚上限（元）"],
         "rows": [["一线城市", "600"], ["二线城市", "400"], ["其他城市", "300"]]},
        {"type": "heading", "level": 1, "text": "交通标准"},
        {"type": "paragraph", "text": "市内交通费实报实销，每日不超过 100 元。"},
        {"type": "paragraph", "text": "跨城高铁行程超过 4 小时的，可乘坐一等座。"},
        {"type": "heading", "level": 1, "text": "报销时限"},
        {"type": "paragraph", "text": "员工应在出差结束后 15 个工作日内提交报销单；逾期超过 30 个工作日的，需财务总监特批。"},
        {"type": "heading", "level": 1, "text": "例外"},
        {"type": "paragraph", "text": "因项目紧急需延长出差的，经项目经理书面确认后不受 15 个工作日限制。"},
    ],
)

LEAVE_MD = DocSpec(
    document_ref="leave_attendance",
    document_family="leave_attendance",
    revision="2026版",
    published_at="2026-01-05",
    effective_from="2026-01-01",
    effective_to=None,
    authority="集团人力资源中心",
    file_name="leave-attendance-policy-2026.md",
    file_type="md",
    title="员工请假与考勤制度",
    blocks=[
        {"type": "heading", "level": 2, "text": "年假"},
        {"type": "paragraph", "text": "入职满 1 年享 5 天年假，满 3 年享 10 天，满 5 年享 15 天。"},
        {"type": "heading", "level": 2, "text": "病假"},
        {"type": "paragraph", "text": "连续病假超过 3 天的，须提供二级以上医院证明。"},
        {"type": "heading", "level": 2, "text": "事假"},
        {"type": "paragraph", "text": "全年累计不得超过 15 天，超过部分不计发工资。"},
        {"type": "heading", "level": 2, "text": "审批权限"},
        {"type": "paragraph", "text": "请假 3 天（含）以内由直属主管审批；3 天以上至 7 天由部门负责人审批；7 天以上由人力资源总监审批。"},
    ],
)

CONTRACT_TXT = DocSpec(
    document_ref="contract_approval",
    document_family="contract_approval",
    revision="2026版",
    published_at="2026-02-01",
    effective_from="2026-02-01",
    effective_to=None,
    authority="集团法务与销售中心",
    file_name="contract-approval-authority-2026.txt",
    file_type="txt",
    title="客户合同审批权限规定",
    blocks=[
        {"type": "heading", "level": 2, "text": "审批权限"},
        {"type": "paragraph", "text": "合同金额 100 万元以下，由销售总监审批。"},
        {"type": "paragraph", "text": "合同金额 100 万元（含）至 500 万元，由分管副总裁审批。"},
        {"type": "paragraph", "text": "合同金额 500 万元（含）以上，须经总经理批准。"},
        {"type": "heading", "level": 2, "text": "特别条款"},
        {"type": "paragraph", "text": "涉及排他条款、无上限赔偿或超过 2 年账期的合同，无论金额大小均须法务与总经理共同审批。"},
        {"type": "heading", "level": 2, "text": "禁止事项"},
        {"type": "paragraph", "text": "禁止先签约后审批。"},
    ],
)

DOCUMENTS: list[DocSpec] = [PROCUREMENT_V2, PROCUREMENT_V1, TRAVEL_PPTX, LEAVE_MD, CONTRACT_TXT]

DEFAULT_SEED = 20261010

"""提示词装配：公共契约 + 角色正文；payload 只替换一次。

SYSTEM = common + [judge_base] + role_system；USER = 角色任务句 + 单次序列化 JSON。
输入中的文档/问题/答案/日志只进 User，不拼入 System。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .core import sha256_text

PROMPT_DIR = Path(__file__).parent / "prompts"

JUDGE_DIMENSIONS: dict[str, str] = {
    "parse_semantics": "judge_parse_semantics",
    "relevance": "judge_relevance",
    "fact_correctness": "judge_fact_correctness",
    "faithfulness": "judge_faithfulness",
    "completeness": "judge_completeness",
    "citation": "judge_citation",
    "behavior": "judge_behavior",
    "dialogue": "judge_dialogue",
}

ROLE_FILES: dict[str, str] = {
    "fact_extract": "fact_extract",
    "question_generate": "question_generate",
    "case_validate": "case_validate",
    "simulate_user": "simulate_user",
    "extract_claims": "extract_claims",
    "review_blind": "review_blind",
    "review_reconcile": "review_reconcile",
    "narrate": "narrate",
    **{f"judge_{name}": file for name, file in JUDGE_DIMENSIONS.items()},
}

USER_TEMPLATES: dict[str, str] = {
    "fact_extract": "从给定独立原文抽取待确认事实候选并记录未决证据。\n{{payload_json}}",
    "question_generate": "根据已确认事实和场景规格生成可审核的问题与多证据任务候选。\n{{payload_json}}",
    "case_validate": "独立审核候选任务的有效性、答案可得性和标准证据完整性。\n{{payload_json}}",
    "simulate_user": "在仅有用户可知信息的范围内生成探索会话的下一步用户动作。\n{{payload_json}}",
    "extract_claims": "从实际答案提取保留条件与定位的原子陈述，不评价其真伪。\n{{payload_json}}",
    "review_blind": "在未见其他裁判结论的条件下独立复核原始证据的全部检查。\n{{payload_json}}",
    "review_reconcile": "基于冻结盲审和原始证据对去身份争议检查逐项定位对账。\n{{payload_json}}",
    "narrate": "将已确认事实包改写为可追溯、保留限制与门禁状态的报告文字。\n{{payload_json}}",
}


def _judge_user(dimension: str) -> str:
    return {
        "parse_semantics": "对照独立原文标准判定实际解析与切块的语义保留检查。",
        "relevance": "分别判定给定检索阶段候选的相关性和对标准事实的证据支持。",
        "fact_correctness": "对照已确认原文标准与明确版本规则判定答案事实正确性。",
        "faithfulness": "仅依据模型实际可见上下文判定各答案陈述的支持关系。",
        "completeness": "逐项核对答案是否正确覆盖所有必需事实、条件、例外及步骤。",
        "citation": "分别核对引用对陈述的支持、应引用覆盖及程序提供的定位检查。",
        "behavior": "按独立可回答性标准和明确行为政策判定作答、拒答、澄清及安全行为。",
        "dialogue": "逐关键轮判定事实、指代、条件继承修改及用户纠正是否符合会话标准。",
    }[dimension] + "\n{{payload_json}}"


@lru_cache(maxsize=None)
def load_prompt(name: str) -> str:
    path = PROMPT_DIR / f"{name}.txt"
    return path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=None)
def common_text() -> str:
    return load_prompt("common")


def build(role: str, payload: dict[str, Any] | list[Any]) -> tuple[str, str, dict[str, str]]:
    """返回 (system, user, prompt_hashes)。"""
    if role not in ROLE_FILES:
        raise KeyError(f"未知提示词角色: {role}")
    role_body = load_prompt(ROLE_FILES[role])
    if role == "review_reconcile":
        system = "\n".join([common_text(), role_body])
    elif role in {"review_blind"}:
        system = "\n".join([common_text(), load_prompt("judge_base"), role_body])
    elif role.startswith("judge_"):
        system = "\n".join([common_text(), load_prompt("judge_base"), role_body])
    else:
        system = "\n".join([common_text(), role_body])
    template = USER_TEMPLATES.get(role) or _judge_user(role.removeprefix("judge_"))
    user = template.replace("{{payload_json}}", json.dumps(payload, ensure_ascii=False), 1)
    hashes = {
        "common": sha256_text(common_text()),
        "role": sha256_text(role_body),
        "system": sha256_text(system),
        "source": ROLE_FILES[role],
    }
    return system, user, hashes


def dimension_role(dimension: str) -> str:
    if dimension not in JUDGE_DIMENSIONS:
        raise KeyError(f"未知维度: {dimension}")
    return f"judge_{dimension}"

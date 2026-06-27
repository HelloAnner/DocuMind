use crate::models::rag::EvidencePack;

#[derive(Debug, Clone)]
pub struct VerificationReport {
    pub confidence: crate::models::Confidence,
    pub issues: Vec<String>,
}

#[async_trait::async_trait]
pub trait ClaimVerifier: Send + Sync {
    async fn verify(&self, answer: &str, evidence: &EvidencePack) -> VerificationReport;
}

pub struct RuleBasedClaimVerifier;

impl RuleBasedClaimVerifier {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RuleBasedClaimVerifier {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ClaimVerifier for RuleBasedClaimVerifier {
    async fn verify(&self, answer: &str, evidence: &EvidencePack) -> VerificationReport {
        let mut issues = vec![];

        let evidence_texts: Vec<String> = evidence
            .chunks
            .iter()
            .map(evidence_text_for_chunk)
            .collect();
        let all_evidence_text = evidence_texts.join("\n");

        for claim in split_claim_segments(answer) {
            let normalized_claim = strip_ordered_list_marker(&strip_citation_markers(&claim));
            let numbers = extract_numbers(&normalized_claim);
            if numbers.is_empty() {
                continue;
            }

            let citation_indexes = cited_evidence_indexes(&claim);
            let cited_text = if citation_indexes.is_empty() {
                all_evidence_text.as_str()
            } else {
                ""
            };

            for num in numbers {
                let found = if citation_indexes.is_empty() {
                    numeric_token_matches(cited_text, &num)
                } else {
                    citation_indexes.iter().any(|index| {
                        evidence_texts
                            .get(index.saturating_sub(1))
                            .map(|text| numeric_token_matches(text, &num))
                            .unwrap_or(false)
                    })
                };

                if !found {
                    let scope = if citation_indexes.is_empty() {
                        "证据".to_string()
                    } else {
                        format!(
                            "引用 {}",
                            citation_indexes
                                .iter()
                                .map(|index| index.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    };
                    issues.push(format!("答案中的数字 {num} 未在 {scope} 中找到"));
                }
            }
        }

        let confidence = if issues.is_empty() {
            crate::models::Confidence::High
        } else if issues.len() <= 2 {
            crate::models::Confidence::Medium
        } else {
            crate::models::Confidence::Low
        };

        VerificationReport { confidence, issues }
    }
}

fn evidence_text_for_chunk(chunk: &crate::models::rag::RerankedChunk) -> String {
    format!(
        "{}\n{}\n{}",
        chunk.chunk.doc_title,
        chunk
            .chunk
            .page_range
            .iter()
            .map(|page| page.to_string())
            .collect::<Vec<_>>()
            .join(" "),
        chunk.chunk.content
    )
}

fn extract_numbers(text: &str) -> Vec<String> {
    let mut numbers = vec![];
    let mut current = String::new();
    let mut has_digit = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == '%' || ch == '.' {
            has_digit |= ch.is_ascii_digit();
            current.push(ch);
        } else if !current.is_empty() {
            if has_digit {
                numbers.push(trim_numeric_token(&current));
            }
            current.clear();
            has_digit = false;
        }
    }
    if !current.is_empty() && has_digit {
        numbers.push(trim_numeric_token(&current));
    }
    numbers
        .into_iter()
        .filter(|number| !number.is_empty())
        .filter(|number| number.chars().any(|ch| ch.is_ascii_digit()))
        .collect()
}

fn trim_numeric_token(token: &str) -> String {
    token.trim_matches(|ch| ch == '.').trim().to_string()
}

fn numeric_token_matches(evidence: &str, token: &str) -> bool {
    if evidence.contains(token) {
        return true;
    }

    let without_percent = token.strip_suffix('%').unwrap_or(token);
    if without_percent != token && evidence.contains(without_percent) {
        return true;
    }

    if !token.ends_with('%') && evidence.contains(&format!("{token}%")) {
        return true;
    }

    false
}

fn strip_citation_markers(text: &str) -> String {
    let mut output = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '[' {
            let mut marker = String::new();
            let mut is_citation = false;
            let mut closed = false;
            while let Some(next) = chars.peek().copied() {
                chars.next();
                if next == ']' {
                    closed = true;
                    is_citation = !marker.is_empty()
                        && marker
                            .split(',')
                            .all(|part| part.trim().chars().all(|c| c.is_ascii_digit()));
                    break;
                }
                marker.push(next);
            }
            if !is_citation {
                output.push('[');
                output.push_str(&marker);
                if closed {
                    output.push(']');
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn cited_evidence_indexes(text: &str) -> Vec<usize> {
    let mut indexes = Vec::new();
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '[' {
            continue;
        }

        let mut marker = String::new();
        while let Some(next) = chars.peek().copied() {
            chars.next();
            if next == ']' {
                break;
            }
            marker.push(next);
        }

        for part in marker.split(',') {
            if let Ok(index) = part.trim().parse::<usize>() {
                if index > 0 && !indexes.contains(&index) {
                    indexes.push(index);
                }
            }
        }
    }

    indexes
}

fn split_claim_segments(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn strip_ordered_list_marker(text: &str) -> String {
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars().peekable();
    let mut digits = String::new();

    while let Some(ch) = chars.peek().copied() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            chars.next();
        } else {
            break;
        }
    }

    if digits.is_empty() {
        return text.to_string();
    }

    if let Some(separator) = chars.peek().copied() {
        if matches!(separator, '.' | '、' | ')') {
            chars.next();
            return chars.collect::<String>().trim_start().to_string();
        }
    }

    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::rag::{EvidencePack, RerankedChunk, RetrievedChunk};
    use crate::models::trace::RetrievalSource;
    use uuid::Uuid;

    fn evidence_with_chunks(contents: &[&str]) -> EvidencePack {
        EvidencePack {
            chunks: contents
                .iter()
                .enumerate()
                .map(|(index, content)| RerankedChunk {
                    chunk: RetrievedChunk {
                        chunk_id: Uuid::new_v4(),
                        doc_id: Uuid::new_v4(),
                        doc_title: format!("测试文档{}.pdf", index + 1),
                        file_type: "pdf".to_string(),
                        content: (*content).to_string(),
                        heading_path: vec![],
                        page_range: vec![index as i32 + 1],
                        block_ids: vec![],
                        table_ids: vec![],
                        anchor_ids: vec![],
                        primary_anchor_id: None,
                        anchor_quality: "structural".to_string(),
                        primary_anchor: None,
                        metadata: serde_json::json!({"source_type": "paragraph"}),
                        score: 0.9,
                        source: RetrievalSource::Rerank,
                    },
                    score: 0.9,
                    rank: index as i32 + 1,
                })
                .collect(),
            context_text: String::new(),
        }
    }

    #[tokio::test]
    async fn verifier_allows_doc_title_page_and_citation_numbers() {
        let evidence = evidence_with_chunks(&[
            "付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。",
        ]);
        let report = RuleBasedClaimVerifier::new()
            .verify(
                "付款节点为：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。[1]",
                &evidence,
            )
            .await;

        assert!(report.issues.is_empty());
        assert_eq!(report.confidence, crate::models::Confidence::High);
    }

    #[tokio::test]
    async fn verifier_checks_numbers_against_cited_evidence() {
        let evidence = evidence_with_chunks(&[
            "付款节点：合同签署后支付首付款30%。",
            "验收通过后支付60%，质保期结束支付10%。",
        ]);

        let report = RuleBasedClaimVerifier::new()
            .verify(
                "付款节点包括验收通过后支付60%，质保结束支付10%。[2]",
                &evidence,
            )
            .await;

        assert!(report.issues.is_empty());
        assert_eq!(report.confidence, crate::models::Confidence::High);
    }

    #[tokio::test]
    async fn verifier_rejects_number_missing_from_cited_evidence() {
        let evidence = evidence_with_chunks(&[
            "付款节点：合同签署后支付首付款30%。",
            "验收通过后支付60%，质保期结束支付10%。",
        ]);

        let report = RuleBasedClaimVerifier::new()
            .verify("付款节点包括验收通过后支付60%。[1]", &evidence)
            .await;

        assert_eq!(report.confidence, crate::models::Confidence::Medium);
        assert_eq!(report.issues, vec!["答案中的数字 60% 未在 引用 1 中找到"]);
    }

    #[tokio::test]
    async fn verifier_ignores_ordered_list_and_citation_numbers() {
        let evidence =
            evidence_with_chunks(&["付款节点：合同签署后支付首付款30%，验收通过后支付60%。"]);

        let report = RuleBasedClaimVerifier::new()
            .verify("1. 首付款30%。[1]\n2. 验收款60%。[1]", &evidence)
            .await;

        assert!(report.issues.is_empty());
        assert_eq!(report.confidence, crate::models::Confidence::High);
    }
}

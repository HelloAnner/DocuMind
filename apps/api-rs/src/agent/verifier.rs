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

        // Check digits/dates/money in answer appear in evidence
        let evidence_text: String = evidence
            .chunks
            .iter()
            .map(|c| {
                format!(
                    "{}\n{}\n{}",
                    c.chunk.doc_title,
                    c.chunk
                        .page_range
                        .iter()
                        .map(|page| page.to_string())
                        .collect::<Vec<_>>()
                        .join(" "),
                    c.chunk.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        // Very simple number/date extraction: any sequence of digits
        let answer_without_citations = strip_citation_markers(answer);
        for num in extract_numbers(&answer_without_citations) {
            if !evidence_text.contains(&num) {
                issues.push(format!("答案中的数字 {num} 未在证据中找到"));
            }
        }

        // Check that claims are followed by citation markers
        for sentence in split_sentences(answer) {
            if sentence.contains('。') && !sentence.contains('[') && sentence.chars().count() > 10
            {
                issues.push(format!("无引用支撑的句子: {sentence}"));
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
        .collect()
}

fn trim_numeric_token(token: &str) -> String {
    token
        .trim_matches(|ch| ch == '.' || ch == '%')
        .trim()
        .to_string()
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

fn split_sentences(text: &str) -> Vec<String> {
    text.split('。').map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::rag::{EvidencePack, RerankedChunk, RetrievedChunk};
    use crate::models::trace::RetrievalSource;
    use uuid::Uuid;

    #[tokio::test]
    async fn verifier_allows_doc_title_page_and_citation_numbers() {
        let evidence = EvidencePack {
            chunks: vec![RerankedChunk {
                chunk: RetrievedChunk {
                    chunk_id: Uuid::new_v4(),
                    doc_id: Uuid::new_v4(),
                    doc_title: "2025年Q3采购合同.pdf".to_string(),
                    file_type: "pdf".to_string(),
                    content:
                        "付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。"
                            .to_string(),
                    heading_path: vec![],
                    page_range: vec![5],
                    block_ids: vec![],
                    table_ids: vec![],
                    metadata: serde_json::json!({"source_type": "paragraph"}),
                    score: 0.9,
                    source: RetrievalSource::Rerank,
                },
                score: 0.9,
                rank: 1,
            }],
            context_text: String::new(),
        };
        let report = RuleBasedClaimVerifier::new()
            .verify(
                "根据《2025年Q3采购合同.pdf》第5页，付款节点为：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。[1]",
                &evidence,
            )
            .await;

        assert!(report.issues.is_empty());
        assert_eq!(report.confidence, crate::models::Confidence::High);
    }
}

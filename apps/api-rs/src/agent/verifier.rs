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

#[async_trait::async_trait]
impl ClaimVerifier for RuleBasedClaimVerifier {
    async fn verify(&self, answer: &str, evidence: &EvidencePack) -> VerificationReport {
        let mut issues = vec![];

        // Check digits/dates/money in answer appear in evidence
        let evidence_text: String = evidence
            .chunks
            .iter()
            .map(|c| c.chunk.content.clone())
            .collect::<Vec<_>>()
            .join("\n");

        // Very simple number/date extraction: any sequence of digits
        for num in extract_numbers(answer) {
            if !evidence_text.contains(&num) {
                issues.push(format!("答案中的数字 {num} 未在证据中找到"));
            }
        }

        // Check that claims are followed by citation markers
        for sentence in split_sentences(answer) {
            if sentence.contains('。') && !sentence.contains('[') && sentence.chars().count() > 10 {
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
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == '%' || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            numbers.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        numbers.push(current);
    }
    numbers
}

fn split_sentences(text: &str) -> Vec<String> {
    text.split('。').map(|s| s.to_string()).collect()
}

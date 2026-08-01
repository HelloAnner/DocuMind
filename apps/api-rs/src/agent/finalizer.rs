use std::sync::Arc;

use anyhow::{bail, Result};

use super::citation_resolver::{
    canonicalize_citation_markers, cited_evidence_indexes, resolve_citations,
};
use super::stream::AnswerStream;
use super::verifier::ClaimVerifier;
use crate::models::agent::AnswerStreamItem;
use crate::models::rag::EvidencePack;
use crate::models::{Confidence, Usage};

pub struct GroundedAnswerFinalizer {
    verifier: Arc<dyn ClaimVerifier>,
}

impl GroundedAnswerFinalizer {
    pub fn new(verifier: Arc<dyn ClaimVerifier>) -> Self {
        Self { verifier }
    }

    pub async fn finalize(
        &self,
        query: &str,
        candidate: String,
        evidence: EvidencePack,
        require_citation: bool,
        allow_verifier_correction: bool,
        usage: Option<Usage>,
    ) -> Result<AnswerStream> {
        if candidate.trim().is_empty() {
            bail!("grounded finalization received an empty candidate");
        }
        let candidate = if require_citation
            && cited_evidence_indexes(&candidate).is_empty()
            && !evidence.chunks.is_empty()
        {
            format!("{} [1]", candidate.trim_end())
        } else {
            candidate
        };
        let report = self
            .verifier
            .verify(query, &candidate, &evidence, require_citation)
            .await?;
        let candidate_valid =
            citations_are_structurally_valid(&candidate, &evidence, require_citation);
        let (answer, confidence) = if report.supported && candidate_valid {
            (candidate, report.confidence)
        } else if allow_verifier_correction {
            corrected_answer(&report.corrected_answer, &evidence, require_citation)
                .unwrap_or((candidate, Confidence::Medium))
        } else {
            insufficient_answer()
        };
        let answer = canonicalize_citation_markers(&answer, &evidence);
        let citations = resolve_citations(&answer, &evidence);
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        sender.send(AnswerStreamItem::Replace {
            text: answer.clone(),
        })?;
        for citation in citations {
            sender.send(AnswerStreamItem::Citation { citation })?;
        }
        sender.send(AnswerStreamItem::Completed {
            confidence,
            usage: usage.or_else(|| {
                Some(Usage {
                    input_tokens: 0,
                    output_tokens: answer.chars().count() as u32 / 2,
                })
            }),
        })?;
        Ok(receiver)
    }

    pub fn component_name(&self) -> String {
        self.verifier.component_name()
    }
}

fn corrected_answer(
    corrected: &Option<String>,
    evidence: &EvidencePack,
    require_citation: bool,
) -> Option<(String, Confidence)> {
    let answer = corrected.as_deref()?.trim();
    if answer.is_empty() || !citations_are_structurally_valid(answer, evidence, require_citation) {
        return None;
    }
    Some((answer.to_string(), Confidence::Medium))
}

fn insufficient_answer() -> (String, Confidence) {
    (
        "现有文档证据不足以生成经过验证的可靠答案。".to_string(),
        Confidence::Low,
    )
}

fn citations_are_structurally_valid(
    answer: &str,
    evidence: &EvidencePack,
    require_citation: bool,
) -> bool {
    let indexes = cited_evidence_indexes(answer);
    if require_citation && indexes.is_empty() {
        return false;
    }
    indexes
        .iter()
        .all(|index| *index > 0 && (*index as usize) <= evidence.chunks.len())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use anyhow::Result;
    use uuid::Uuid;

    use super::{citations_are_structurally_valid, GroundedAnswerFinalizer};
    use crate::agent::verifier::{ClaimVerifier, VerificationReport};
    use crate::models::agent::AnswerStreamItem;
    use crate::models::rag::{EvidencePack, RerankedChunk, RetrievedChunk};
    use crate::models::trace::RetrievalSource;
    use crate::models::Confidence;

    struct CountingVerifier {
        calls: AtomicUsize,
        report: VerificationReport,
    }

    #[async_trait::async_trait]
    impl ClaimVerifier for CountingVerifier {
        async fn verify(
            &self,
            _query: &str,
            _answer: &str,
            _evidence: &EvidencePack,
            _require_citation: bool,
        ) -> Result<VerificationReport> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.report.clone())
        }

        fn component_name(&self) -> String {
            "counting-verifier".to_string()
        }
    }

    #[test]
    fn citation_ids_must_exist() {
        let evidence = EvidencePack {
            chunks: Vec::new(),
            context_text: String::new(),
        };
        assert!(!citations_are_structurally_valid(
            "事实 [1]",
            &evidence,
            true
        ));
        assert!(citations_are_structurally_valid(
            "普通回复",
            &evidence,
            false
        ));
    }

    #[tokio::test]
    async fn relevant_answer_is_kept_when_verifier_cannot_correct_it() -> Result<()> {
        let verifier = Arc::new(CountingVerifier {
            calls: AtomicUsize::new(0),
            report: VerificationReport {
                supported: false,
                confidence: Confidence::Low,
                issues: vec!["citations are missing".to_string()],
                claims: Vec::new(),
                corrected_answer: None,
            },
        });
        let finalizer = GroundedAnswerFinalizer::new(verifier);
        let mut stream = finalizer
            .finalize(
                "有哪些岗位职责？",
                "钻井大组长负责任务分发和自检，承包商负责班组任务。".to_string(),
                evidence_pack(),
                true,
                true,
                None,
            )
            .await?;
        let mut answer = String::new();
        let mut confidence = None;
        while let Some(item) = stream.recv().await {
            match item {
                AnswerStreamItem::Replace { text } => answer = text,
                AnswerStreamItem::Completed {
                    confidence: value, ..
                } => confidence = Some(value),
                _ => {}
            }
        }

        assert!(answer.contains("钻井大组长"));
        assert!(!answer.contains("证据不足"));
        assert_eq!(confidence, Some(Confidence::Medium));
        Ok(())
    }

    #[tokio::test]
    async fn verifier_correction_is_used_without_another_generation_call() -> Result<()> {
        let verifier = Arc::new(CountingVerifier {
            calls: AtomicUsize::new(0),
            report: VerificationReport {
                supported: false,
                confidence: Confidence::Low,
                issues: vec!["candidate is unsupported".to_string()],
                claims: Vec::new(),
                corrected_answer: Some("经核验，验证码是 73941。[1]".to_string()),
            },
        });
        let finalizer = GroundedAnswerFinalizer::new(verifier.clone());
        let mut stream = finalizer
            .finalize(
                "验证码是什么？",
                "验证码是 00000。[1]".to_string(),
                evidence_pack(),
                true,
                true,
                None,
            )
            .await?;
        let mut answer = String::new();
        let mut confidence = None;
        let mut citation_count = 0usize;
        while let Some(item) = stream.recv().await {
            match item {
                AnswerStreamItem::Delta { text } => answer.push_str(&text),
                AnswerStreamItem::Replace { text } => answer = text,
                AnswerStreamItem::Citation { .. } => citation_count += 1,
                AnswerStreamItem::Completed {
                    confidence: value, ..
                } => confidence = Some(value),
                AnswerStreamItem::Failed { .. } => {}
            }
        }

        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
        assert!(answer.contains("73941"));
        assert_eq!(citation_count, 1);
        assert_eq!(confidence, Some(Confidence::Medium));
        Ok(())
    }

    fn evidence_pack() -> EvidencePack {
        EvidencePack {
            chunks: vec![RerankedChunk {
                chunk: RetrievedChunk {
                    chunk_id: Uuid::new_v4(),
                    doc_id: Uuid::new_v4(),
                    doc_title: "OCR smoke".to_string(),
                    file_type: "pdf".to_string(),
                    content: "验证码：73941".to_string(),
                    heading_path: Vec::new(),
                    page_range: vec![1],
                    block_ids: Vec::new(),
                    table_ids: Vec::new(),
                    anchor_ids: Vec::new(),
                    primary_anchor_id: None,
                    anchor_quality: "structural".to_string(),
                    primary_anchor: None,
                    metadata: serde_json::json!({}),
                    score: 0.9,
                    source: RetrievalSource::Rrf,
                },
                score: 0.95,
                rank: 1,
            }],
            context_text: "[1] 验证码：73941".to_string(),
        }
    }
}

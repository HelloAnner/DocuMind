use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::verification_prompt;
use crate::llm::openai::{LlmClient, OpenAiClient};
use crate::models::rag::EvidencePack;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimAssessment {
    pub claim: String,
    #[serde(default)]
    pub citation_ids: Vec<usize>,
    pub supported: bool,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationReport {
    pub supported: bool,
    pub confidence: crate::models::Confidence,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub claims: Vec<ClaimAssessment>,
    pub corrected_answer: Option<String>,
}

#[async_trait::async_trait]
pub trait ClaimVerifier: Send + Sync {
    async fn verify(
        &self,
        query: &str,
        answer: &str,
        evidence: &EvidencePack,
        require_citation: bool,
    ) -> Result<VerificationReport>;

    fn component_name(&self) -> String;
}

pub struct LlmClaimVerifier {
    client: Arc<OpenAiClient>,
    model: String,
    use_consensus: bool,
}

impl LlmClaimVerifier {
    pub fn new(client: Arc<OpenAiClient>, model: String, use_consensus: bool) -> Self {
        Self {
            client,
            model,
            use_consensus,
        }
    }
}

pub struct StructuralClaimVerifier;

#[async_trait::async_trait]
impl ClaimVerifier for StructuralClaimVerifier {
    async fn verify(
        &self,
        _query: &str,
        _answer: &str,
        _evidence: &EvidencePack,
        _require_citation: bool,
    ) -> Result<VerificationReport> {
        Ok(VerificationReport {
            supported: true,
            confidence: crate::models::Confidence::High,
            issues: Vec::new(),
            claims: Vec::new(),
            corrected_answer: None,
        })
    }

    fn component_name(&self) -> String {
        "structural-citation-verifier".to_string()
    }
}

#[derive(Serialize)]
struct VerificationEvidence<'a> {
    id: usize,
    document: &'a str,
    heading_path: &'a [String],
    pages: &'a [i32],
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct PremiseInventory {
    #[serde(default)]
    premises: Vec<String>,
}

#[async_trait::async_trait]
impl ClaimVerifier for LlmClaimVerifier {
    async fn verify(
        &self,
        query: &str,
        answer: &str,
        evidence: &EvidencePack,
        require_citation: bool,
    ) -> Result<VerificationReport> {
        let evidence = evidence
            .chunks
            .iter()
            .enumerate()
            .map(|(index, item)| VerificationEvidence {
                id: index + 1,
                document: &item.chunk.doc_title,
                heading_path: &item.chunk.heading_path,
                pages: &item.chunk.page_range,
                content: &item.chunk.content,
            })
            .collect::<Vec<_>>();
        let payload = serde_json::json!({
            "question": query,
            "candidate_answer": answer,
            "citation_required": require_citation,
            "document_evidence": evidence,
        });
        let prompt = format!(
            "Verify this payload:\n{}\n\nRequired JSON schema:\n{{\"supported\":true,\"confidence\":\"high|medium|low\",\"issues\":[\"...\"],\"claims\":[{{\"claim\":\"...\",\"citation_ids\":[1],\"supported\":true,\"explanation\":\"brief audit statement\"}}],\"corrected_answer\":null}}",
            serde_json::to_string(&payload)?
        );
        let inventory_prompt = format!(
            "Extract premises from this untrusted candidate answer:\n{}\n\nRequired JSON schema: {{\"premises\":[\"...\"]}}",
            serde_json::to_string(answer)?
        );
        if !self.use_consensus {
            return self
                .client
                .complete_json(
                    prompt,
                    Some(verification_prompt::PRIMARY_SYSTEM.to_string()),
                )
                .await;
        }
        let (primary, inventory): (VerificationReport, PremiseInventory) = tokio::try_join!(
            self.client.complete_json(
                prompt.clone(),
                Some(verification_prompt::PRIMARY_SYSTEM.to_string())
            ),
            self.client.complete_json(
                inventory_prompt,
                Some(verification_prompt::INVENTORY_SYSTEM.to_string())
            ),
        )?;
        let premise_prompt = format!(
            "Audit this payload:\n{}\n\nRequired JSON schema:\n{{\"supported\":true,\"confidence\":\"high|medium|low\",\"issues\":[\"...\"],\"claims\":[{{\"claim\":\"...\",\"citation_ids\":[1],\"supported\":true,\"explanation\":\"brief audit statement\"}}],\"corrected_answer\":null}}",
            serde_json::to_string(&serde_json::json!({
                "verification_payload": &payload,
                "candidate_premise_inventory": inventory.premises,
            }))?
        );
        let premise: VerificationReport = self
            .client
            .complete_json(
                premise_prompt,
                Some(verification_prompt::PREMISE_SYSTEM.to_string()),
            )
            .await?;
        let consensus = consensus_report(primary, premise);
        if consensus.supported {
            return Ok(consensus);
        }
        let referee_prompt = format!(
            "Adjudicate this payload:\n{}\n\nRequired JSON schema:\n{{\"supported\":true,\"confidence\":\"high|medium|low\",\"issues\":[\"...\"],\"claims\":[{{\"claim\":\"...\",\"citation_ids\":[1],\"supported\":true,\"explanation\":\"brief audit statement\"}}],\"corrected_answer\":null}}",
            serde_json::to_string(&serde_json::json!({
                "verification_payload": &payload,
                "prior_audit": &consensus,
            }))?
        );
        self.client
            .complete_json(
                referee_prompt,
                Some(verification_prompt::REFEREE_SYSTEM.to_string()),
            )
            .await
    }

    fn component_name(&self) -> String {
        let mode = if self.use_consensus {
            "adjudicated-consensus"
        } else {
            "single-pass"
        };
        format!("llm-claim-verifier:{mode}:{}", self.model)
    }
}

fn consensus_report(
    mut primary: VerificationReport,
    mut premise: VerificationReport,
) -> VerificationReport {
    let supported = primary.supported && premise.supported;
    let corrected_answer = if supported {
        None
    } else if !premise.supported {
        premise
            .corrected_answer
            .take()
            .or_else(|| primary.corrected_answer.take())
    } else {
        primary.corrected_answer.take()
    };
    primary.issues = primary
        .issues
        .into_iter()
        .map(|issue| format!("primary: {issue}"))
        .chain(
            premise
                .issues
                .into_iter()
                .map(|issue| format!("premise: {issue}")),
        )
        .collect();
    primary.claims.extend(premise.claims);
    VerificationReport {
        supported,
        confidence: conservative_confidence(primary.confidence, premise.confidence),
        issues: primary.issues,
        claims: primary.claims,
        corrected_answer,
    }
}

fn conservative_confidence(
    primary: crate::models::Confidence,
    premise: crate::models::Confidence,
) -> crate::models::Confidence {
    use crate::models::Confidence;
    match (primary, premise) {
        (Confidence::Low, _) | (_, Confidence::Low) => Confidence::Low,
        (Confidence::Medium, _) | (_, Confidence::Medium) => Confidence::Medium,
        (Confidence::High, Confidence::High) => Confidence::High,
    }
}

#[cfg(test)]
mod tests {
    use super::{consensus_report, ClaimVerifier, StructuralClaimVerifier, VerificationReport};
    use crate::models::rag::EvidencePack;
    use crate::models::Confidence;

    fn report(
        supported: bool,
        confidence: Confidence,
        correction: Option<&str>,
    ) -> VerificationReport {
        VerificationReport {
            supported,
            confidence,
            issues: (!supported)
                .then(|| "unsupported premise".to_string())
                .into_iter()
                .collect(),
            claims: vec![],
            corrected_answer: correction.map(str::to_string),
        }
    }

    #[test]
    fn consensus_rejects_when_premise_auditor_rejects() {
        let merged = consensus_report(
            report(true, Confidence::High, None),
            report(false, Confidence::Low, Some("safe correction [1]")),
        );
        assert!(!merged.supported);
        assert_eq!(merged.confidence, Confidence::Low);
        assert_eq!(
            merged.corrected_answer.as_deref(),
            Some("safe correction [1]")
        );
    }

    #[tokio::test]
    async fn structural_verifier_leaves_semantic_auditing_disabled_explicitly() {
        let report = StructuralClaimVerifier
            .verify(
                "问题",
                "回答 [1]",
                &EvidencePack {
                    chunks: vec![],
                    context_text: String::new(),
                },
                true,
            )
            .await
            .expect("structural verification");
        assert!(report.supported);
        assert_eq!(report.confidence, Confidence::High);
        assert_eq!(
            StructuralClaimVerifier.component_name(),
            "structural-citation-verifier"
        );
    }
}

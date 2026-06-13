use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Up,
    Down,
}

impl std::fmt::Display for Rating {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Rating::Up => write!(f, "up"),
            Rating::Down => write!(f, "down"),
        }
    }
}

impl std::str::FromStr for Rating {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "up" => Ok(Rating::Up),
            "down" => Ok(Rating::Down),
            _ => Err(format!("unknown rating: {s}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackReason {
    Helpful,
    WrongAnswer,
    MissingSource,
    Outdated,
    NotHelpful,
    Other,
}

impl std::fmt::Display for FeedbackReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FeedbackReason::Helpful => write!(f, "helpful"),
            FeedbackReason::WrongAnswer => write!(f, "wrong_answer"),
            FeedbackReason::MissingSource => write!(f, "missing_source"),
            FeedbackReason::Outdated => write!(f, "outdated"),
            FeedbackReason::NotHelpful => write!(f, "not_helpful"),
            FeedbackReason::Other => write!(f, "other"),
        }
    }
}

impl std::str::FromStr for FeedbackReason {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "helpful" => Ok(FeedbackReason::Helpful),
            "wrong_answer" => Ok(FeedbackReason::WrongAnswer),
            "missing_source" => Ok(FeedbackReason::MissingSource),
            "outdated" => Ok(FeedbackReason::Outdated),
            "not_helpful" => Ok(FeedbackReason::NotHelpful),
            "other" => Ok(FeedbackReason::Other),
            _ => Err(format!("unknown feedback reason: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feedback {
    pub id: Uuid,
    pub assistant_message_id: Uuid,
    pub user_id: Uuid,
    pub rating: Rating,
    pub reason: Option<FeedbackReason>,
    pub comment: Option<String>,
    pub correction: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitFeedbackRequest {
    pub rating: Rating,
    #[serde(default)]
    pub reason: Option<FeedbackReason>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub correction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackResponse {
    pub feedback_id: Uuid,
    pub message_id: Uuid,
    pub created_at: DateTime<Utc>,
}

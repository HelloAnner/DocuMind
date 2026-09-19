// 移植自 apps/api-rs/src/models/feedback.rs
export type Rating = 'up' | 'down';
export type FeedbackReason =
  | 'helpful' | 'wrong_answer' | 'missing_source' | 'outdated' | 'not_helpful' | 'other';

export interface Feedback {
  id: string; assistant_message_id: string; user_id: string; rating: Rating;
  reason: FeedbackReason | null; comment: string | null; correction: string | null;
  created_at: string; updated_at: string; cleared_at: string | null;
}
export interface SubmitFeedbackRequest {
  rating: Rating; reason?: FeedbackReason | null; comment?: string | null; correction?: string | null;
}
export interface FeedbackResponse {
  feedback_id: string; message_id: string; rating: Rating; reason: FeedbackReason | null;
  comment: string | null; correction: string | null; created_at: string; updated_at: string;
}
export interface DeleteFeedbackResponse { message_id: string; }

export function feedbackToResponse(feedback: Feedback): FeedbackResponse {
  return {
    feedback_id: feedback.id, message_id: feedback.assistant_message_id, rating: feedback.rating,
    reason: feedback.reason, comment: feedback.comment, correction: feedback.correction,
    created_at: feedback.created_at, updated_at: feedback.updated_at,
  };
}

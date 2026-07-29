use tokio::sync::mpsc::UnboundedReceiver;

use crate::models::agent::AnswerStreamItem;

pub type AnswerStream = UnboundedReceiver<AnswerStreamItem>;

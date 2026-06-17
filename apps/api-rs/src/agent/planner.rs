use anyhow::Result;

use crate::models::agent::RewriteOutput;
use crate::models::trace::{PlanMode, RetrievalPlan, SubQuery};

#[async_trait::async_trait]
pub trait RetrievalPlanner: Send + Sync {
    async fn plan(&self, original_query: &str, rewrite: &RewriteOutput) -> Result<RetrievalPlan>;
}

pub struct RuleBasedRetrievalPlanner;

impl RuleBasedRetrievalPlanner {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl RetrievalPlanner for RuleBasedRetrievalPlanner {
    async fn plan(&self, original_query: &str, rewrite: &RewriteOutput) -> Result<RetrievalPlan> {
        let q = original_query.to_lowercase();
        let multi = q.contains("对比")
            || q.contains("区别")
            || (q.contains("和") && q.contains("比"))
            || q.contains("分别");

        if multi {
            let sub1 = SubQuery {
                query: rewrite.rewritten_query.clone(),
                reason: "主查询：检索用户核心问题".to_string(),
            };
            let sub2 = SubQuery {
                query: format!("{} 相关条款", rewrite.rewritten_query),
                reason: "补充检索相关条款与例外".to_string(),
            };
            Ok(RetrievalPlan {
                mode: PlanMode::Multi,
                queries: vec![sub1, sub2],
            })
        } else {
            Ok(RetrievalPlan {
                mode: PlanMode::Single,
                queries: vec![SubQuery {
                    query: rewrite.rewritten_query.clone(),
                    reason: "直接检索用户问题".to_string(),
                }],
            })
        }
    }
}

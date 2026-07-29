use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::{AgentTool, ToolExecution, ToolExecutionContext};
use crate::agent::model::{AgentToolCall, AgentToolDefinition};

#[derive(Clone, Default)]
pub struct AgentToolRegistry {
    tools: Arc<HashMap<String, Arc<dyn AgentTool>>>,
}

impl AgentToolRegistry {
    pub fn new(tools: Vec<Arc<dyn AgentTool>>) -> Result<Self> {
        let mut by_name = HashMap::new();
        for tool in tools {
            let name = tool.definition().name;
            if by_name.insert(name.clone(), tool).is_some() {
                return Err(anyhow!("duplicate agent tool registration: {name}"));
            }
        }
        Ok(Self {
            tools: Arc::new(by_name),
        })
    }

    pub fn definitions(&self) -> Vec<AgentToolDefinition> {
        let mut definitions = self
            .tools
            .values()
            .map(|tool| tool.definition())
            .collect::<Vec<_>>();
        definitions.sort_by(|left, right| left.name.cmp(&right.name));
        definitions
    }

    pub async fn execute(
        &self,
        call: &AgentToolCall,
        context: &ToolExecutionContext<'_>,
    ) -> Result<ToolExecution> {
        let tool = self
            .tools
            .get(&call.name)
            .ok_or_else(|| anyhow!("model requested unavailable tool: {}", call.name))?;
        tool.execute(call, context).await
    }

    pub fn component_name(&self, name: &str) -> Option<String> {
        self.tools.get(name).map(|tool| tool.component_name())
    }
}

#[cfg(test)]
mod tests {
    use super::AgentToolRegistry;

    #[test]
    fn empty_registry_has_no_definitions() {
        let registry = AgentToolRegistry::new(Vec::new()).expect("empty registry is valid");
        assert!(registry.definitions().is_empty());
    }
}

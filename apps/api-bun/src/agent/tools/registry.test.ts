// 移植自 apps/api-rs/src/agent/tools/registry.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { AgentToolRegistry } from './registry.ts';

describe('agent tool registry', () => {
  test('empty_registry_has_no_definitions', () => {
    const registry = new AgentToolRegistry([]);
    expect(registry.definitions()).toHaveLength(0);
  });
});

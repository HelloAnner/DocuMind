import { ApiClient } from "./api.ts";
import { ChatService } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { ApiError, CliError } from "./errors.ts";
import type { ChatRunReport, CliConfig, CreatedApiClient } from "./types.ts";

interface VerificationTarget {
  admin: ApiClient;
  kbId: string;
  created: CreatedApiClient;
  external: ApiClient;
  chat: ChatRunReport;
}

export async function verifyExternalApi(
  admin: ApiClient,
  options: { kbId?: string; deniedKbId?: string; question: string; otherConfigPath?: string },
): Promise<Record<string, unknown>> {
  const checks: Array<Record<string, unknown>> = [];
  const primary = await createAndChat(admin, options.kbId, options.question, "primary", checks);

  if (options.deniedKbId) {
    await expectStatus(
      () => primary.external.createConversation([options.deniedKbId!]),
      403,
      "knowledge_base_isolation",
      checks,
    );
  }

  const rotated = await primary.admin.createApiToken(primary.created.client.id, 30);
  setExternalToken(primary.admin.config, rotated.secret);
  await primary.external.externalMe();
  checks.push({ name: "token_rotation", ok: true, token_id: rotated.token.id });

  await primary.admin.revokeApiToken(
    primary.created.client.id,
    primary.created.client.tokens[0]!.id,
  );
  setExternalToken(primary.admin.config, primary.created.token);
  await expectStatus(() => primary.external.externalMe(), 401, "revoked_token_rejected", checks);
  setExternalToken(primary.admin.config, rotated.secret);

  await primary.admin.updateApiClientStatus(primary.created.client.id, "disabled");
  await expectStatus(() => primary.external.externalMe(), 401, "disabled_client_rejected", checks);
  await primary.admin.updateApiClientStatus(primary.created.client.id, "active");
  await primary.external.externalMe();
  checks.push({ name: "client_reenabled", ok: true });

  await verifyRateLimit(primary.admin, primary.kbId, checks);

  let secondary: VerificationTarget | undefined;
  if (options.otherConfigPath) {
    const config = await loadConfig(options.otherConfigPath);
    secondary = await createAndChat(
      new ApiClient(config, options.otherConfigPath),
      undefined,
      options.question,
      "secondary",
      checks,
    );
    if (secondary.created.client.id === primary.created.client.id) {
      throw new CliError("两个租户生成了相同 API Client ID");
    }
    setExternalToken(primary.admin.config, rotated.secret);
    await expectStatus(
      () => primary.external.getMessages(secondary!.chat.request.conversation_id),
      404,
      "cross_tenant_conversation_isolation",
      checks,
    );
    checks.push({
      name: "tenant_identity_distinct",
      ok: true,
      primary_tenant: (await primary.external.externalMe()).tenant_id,
      secondary_tenant: secondary.chat.identity.tenant_id,
    });
  }

  await primary.admin.revokeApiToken(primary.created.client.id, rotated.token.id);
  await primary.admin.updateApiClientStatus(primary.created.client.id, "disabled");
  if (secondary) {
    const active = secondary.created.client.tokens.find((token) => token.status === "active");
    if (active) await secondary.admin.revokeApiToken(secondary.created.client.id, active.id);
    await secondary.admin.updateApiClientStatus(secondary.created.client.id, "disabled");
  }
  checks.push({ name: "cleanup", ok: true });

  return {
    ok: checks.every((check) => check.ok === true),
    checks,
    primary_chat: summarizeChat(primary.chat),
    ...(secondary ? { secondary_chat: summarizeChat(secondary.chat) } : {}),
  };
}

async function createAndChat(
  admin: ApiClient,
  requestedKbId: string | undefined,
  question: string,
  label: string,
  checks: Array<Record<string, unknown>>,
): Promise<VerificationTarget> {
  const knowledgeBases = await admin.listAdminKnowledgeBases();
  const kbId = requestedKbId ?? knowledgeBases[0]?.id;
  if (!kbId || !knowledgeBases.some((kb) => kb.id === kbId)) {
    throw new CliError(`${label} 租户不存在待测知识库 ${kbId ?? ""}`);
  }
  const created = await admin.createApiClient({
    name: `cli-verify-${label}-${Date.now()}`,
    description: "DocuMind CLI automated external API verification",
    kb_ids: [kbId],
    expires_in_days: 30,
    rate_limit_per_minute: 100,
  });
  setExternalToken(admin.config, created.token);
  const external = new ApiClient(admin.config, admin.configPath).enableExternalMode();
  const identity = await external.externalMe();
  const visibleKbs = await external.listKnowledgeBases();
  if (!identity.tenant_id) throw new CliError(`${label} API identity 缺少租户`);
  if (visibleKbs.length !== 1 || visibleKbs[0]?.id !== kbId) {
    throw new CliError(`${label} API Client 知识库范围错误`);
  }
  checks.push({ name: `${label}_identity_and_kb_scope`, ok: true, tenant_id: identity.tenant_id, kb_id: kbId });

  const chat = await new ChatService(external).send({ content: question, kb_ids: [kbId] });
  if (chat.response.status !== "completed" || !chat.response.content.trim()) {
    throw new CliError(`${label} 真实问答未完成`, 1, chat);
  }
  checks.push({
    name: `${label}_real_chat`,
    ok: true,
    conversation_id: chat.request.conversation_id,
    answer_length: chat.response.content.length,
    citations: chat.citations.length,
  });
  return { admin, kbId, created, external, chat };
}

async function verifyRateLimit(
  admin: ApiClient,
  kbId: string,
  checks: Array<Record<string, unknown>>,
): Promise<void> {
  const created = await admin.createApiClient({
    name: `cli-verify-rate-${Date.now()}`,
    kb_ids: [kbId],
    expires_in_days: 1,
    rate_limit_per_minute: 2,
  });
  setExternalToken(admin.config, created.token);
  const external = new ApiClient(admin.config, admin.configPath).enableExternalMode();
  await external.externalMe();
  await external.externalMe();
  await expectStatus(() => external.externalMe(), 429, "rate_limit", checks);
  await admin.revokeApiToken(created.client.id, created.client.tokens[0]!.id);
  await admin.updateApiClientStatus(created.client.id, "disabled");
}

async function expectStatus(
  operation: () => Promise<unknown>,
  status: number,
  name: string,
  checks: Array<Record<string, unknown>>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ApiError && error.status === status) {
      checks.push({ name, ok: true, status });
      return;
    }
    throw error;
  }
  throw new CliError(`${name} 未返回预期状态 ${status}`);
}

function setExternalToken(config: CliConfig, token: string): void {
  process.env[config.external.token_env] = token;
}

function summarizeChat(chat: ChatRunReport): Record<string, unknown> {
  return {
    tenant_id: chat.identity.tenant_id,
    conversation_id: chat.request.conversation_id,
    assistant_message_id: chat.response.assistant_message_id,
    answer: chat.response.content,
    confidence: chat.response.confidence,
    citations: chat.citations,
    timing: chat.timing,
  };
}

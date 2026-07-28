import { afterEach, describe, expect, test } from "bun:test";
import {
  configuredPassword,
  DEFAULT_CONFIG,
  parseConfig,
  serializeConfig,
} from "../src/config.ts";

describe("configuration", () => {
  afterEach(() => {
    delete process.env.DOCUMIND_TEST_PASSWORD;
  });

  test("round trips the default TOML configuration", () => {
    const parsed = parseConfig(serializeConfig(DEFAULT_CONFIG));
    expect(parsed).toEqual(DEFAULT_CONFIG);
    expect(parsed.diagnostics.elasticsearch_index).toBe("chunks_search");
  });

  test("uses password environment variable before plaintext config", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth.password = "config-secret";
    config.auth.password_env = "DOCUMIND_TEST_PASSWORD";
    process.env.DOCUMIND_TEST_PASSWORD = "environment-secret";
    expect(configuredPassword(config)).toBe("environment-secret");
  });

  test("migrates the legacy physical Elasticsearch index to the active alias", () => {
    const legacy = serializeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      diagnostics: {
        ...DEFAULT_CONFIG.diagnostics,
        elasticsearch_index: "chunks",
      },
    });
    expect(parseConfig(legacy).diagnostics.elasticsearch_index).toBe("chunks_search");
  });

  test("rejects unsafe server protocols", () => {
    const text = serializeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      server: { ...DEFAULT_CONFIG.server, url: "file:///etc/passwd" },
    });
    expect(() => parseConfig(text)).toThrow("http 或 https");
  });
});

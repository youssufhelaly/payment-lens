import { describe, expect, it } from "vitest";
import { ConfigError, cursorConfig, llmProvider, ollamaConfig, readOnlyStripeKey, seedStripeKey } from "../src/config";

describe("readOnlyStripeKey", () => {
  it("accepts a restricted test-mode key", () => {
    expect(readOnlyStripeKey({ STRIPE_READONLY_KEY: "rk_test_abc123" })).toBe("rk_test_abc123");
  });

  it.each(["sk_test_abc123", "rk_live_abc123", "sk_live_abc123", "pk_test_abc123", "rk_test_"])(
    "rejects %s",
    (key) => {
      expect(() => readOnlyStripeKey({ STRIPE_READONLY_KEY: key })).toThrow(ConfigError);
    },
  );

  it("explains what to do when the key is missing", () => {
    expect(() => readOnlyStripeKey({})).toThrow(/rk_test_/);
  });
});

describe("seedStripeKey", () => {
  it("accepts only test-mode secret keys", () => {
    expect(seedStripeKey({ STRIPE_SEED_KEY: "sk_test_abc" })).toBe("sk_test_abc");
    expect(() => seedStripeKey({ STRIPE_SEED_KEY: "sk_live_abc" })).toThrow(ConfigError);
  });
});

describe("provider config", () => {
  it("defaults to ollama and rejects unknown providers", () => {
    expect(llmProvider({})).toBe("ollama");
    expect(llmProvider({ LLM_PROVIDER: "cursor" })).toBe("cursor");
    expect(llmProvider({ LLM_PROVIDER: "cursor" }, "ollama")).toBe("ollama");
    expect(() => llmProvider({ LLM_PROVIDER: "openai" })).toThrow(ConfigError);
  });

  it("requires a Cursor API key and validates model ids", () => {
    expect(() => cursorConfig({})).toThrow(/CURSOR_API_KEY/);
    expect(cursorConfig({ CURSOR_API_KEY: "key_123" })).toEqual({ apiKey: "key_123", model: "composer-2.5" });
    expect(() => cursorConfig({ CURSOR_API_KEY: "key_123" }, "model; rm -rf /")).toThrow(ConfigError);
  });
});

describe("ollamaConfig", () => {
  it("defaults to a local llama model", () => {
    expect(ollamaConfig({})).toEqual({ baseUrl: "http://localhost:11434", model: "llama3.1:8b" });
  });

  it("requires https for remote hosts", () => {
    expect(() => ollamaConfig({ OLLAMA_URL: "http://gpu-box.internal:11434" })).toThrow(/https/);
    expect(ollamaConfig({ OLLAMA_URL: "https://gpu-box.internal" }).baseUrl).toBe("https://gpu-box.internal");
  });
});

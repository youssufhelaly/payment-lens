const READONLY_KEY = /^rk_test_[A-Za-z0-9]+$/;
const SEED_KEY = /^sk_test_[A-Za-z0-9]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

export function loadDotEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * The agent only ever receives a restricted test-mode key. Secret keys (sk_) carry
 * write access and live keys touch real money, so both are rejected outright.
 */
export function readOnlyStripeKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.STRIPE_READONLY_KEY?.trim();
  if (!key) {
    throw new ConfigError(
      "STRIPE_READONLY_KEY is not set. Create a restricted test-mode key (rk_test_...) with read-only permissions; see README.",
    );
  }
  if (!READONLY_KEY.test(key)) {
    throw new ConfigError(
      "STRIPE_READONLY_KEY must be a restricted test-mode key (rk_test_...). Secret keys (sk_...) and live keys are rejected so the agent never holds write access.",
    );
  }
  return key;
}

export function seedStripeKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.STRIPE_SEED_KEY?.trim();
  if (!key) throw new ConfigError("STRIPE_SEED_KEY is not set. Use a test-mode secret key (sk_test_...).");
  if (!SEED_KEY.test(key)) {
    throw new ConfigError("STRIPE_SEED_KEY must be a test-mode secret key (sk_test_...). Live keys are rejected.");
  }
  return key;
}

export type LlmProvider = "ollama" | "cursor";

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/;

export function llmProvider(env: NodeJS.ProcessEnv = process.env, override?: string): LlmProvider {
  const value = (override ?? env.LLM_PROVIDER ?? "ollama").trim();
  if (value !== "ollama" && value !== "cursor") throw new ConfigError(`LLM provider must be "ollama" or "cursor", got "${value}".`);
  return value;
}

export function modelId(value: string): string {
  if (!MODEL_ID.test(value)) throw new ConfigError(`Invalid model id: ${value}`);
  return value;
}

export function cursorConfig(env: NodeJS.ProcessEnv = process.env, modelOverride?: string): { apiKey: string; model: string } {
  const apiKey = env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError("CURSOR_API_KEY is not set. Create one at cursor.com/dashboard/integrations and add it to .env.");
  }
  return { apiKey, model: modelId(modelOverride ?? (env.CURSOR_MODEL?.trim() || "composer-2.5")) };
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
}

export function ollamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const raw = env.OLLAMA_URL?.trim() || "http://localhost:11434";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`OLLAMA_URL is not a valid URL: ${raw}`);
  }
  if (!LOCAL_HOSTS.has(url.hostname) && url.protocol !== "https:") {
    throw new ConfigError("OLLAMA_URL must use https unless it points at localhost.");
  }
  return { baseUrl: url.origin, model: env.OLLAMA_MODEL?.trim() || "llama3.1:8b" };
}

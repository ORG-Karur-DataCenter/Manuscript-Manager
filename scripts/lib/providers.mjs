import { STRICT_JSON_SCHEMA, toGeminiSchema } from "./schema.mjs";

/**
 * Free-tier LLM backends, all reached over plain fetch (Node 18+ has it built in)
 * so the project carries no vendor SDK.
 *
 * Every provider here has a permanently free tier that needs no card. They are
 * tried in order: if one is rate limited or down, the next one answers, so a
 * quota ceiling degrades the tracker instead of stopping it.
 */

class ProviderError extends Error {
  constructor(
    message,
    { retryable = false, status = null, rateLimited = false, retryAfterMs = null } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    // A quota ceiling is not the email's fault: callers use this to retry the
    // message later instead of counting it toward a give-up budget.
    this.rateLimited = rateLimited;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long a 429 wants us to wait. Providers say so in a Retry-After header;
 * Gemini also embeds a RetryInfo duration in the error body.
 */
function parseRetryAfter(response, body) {
  const header = response.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body || "");
  if (match) return Number(match[1]) * 1000;
  return null;
}

/** Free tiers are throttled per minute, so pace requests rather than eat 429s. */
function createPacer(minIntervalMs) {
  let last = 0;
  return async function pace() {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

async function postJson(url, { headers, body, timeoutMs = 90000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ProviderError(`network error: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // 429 = quota, 5xx = transient. Both are worth another provider or another try.
    const rateLimited = response.status === 429;
    const retryable = rateLimited || response.status >= 500;
    throw new ProviderError(
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      {
        retryable,
        status: response.status,
        rateLimited,
        retryAfterMs: rateLimited ? parseRetryAfter(response, text) : null,
      }
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`non-JSON response: ${text.slice(0, 200)}`, {
      retryable: true,
    });
  }
}

function parseModelJson(raw, providerName) {
  if (!raw) throw new ProviderError(`${providerName} returned empty content`, { retryable: true });
  // Some models wrap JSON in a ```json fence even under schema enforcement.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: pull the outermost object out of surrounding prose.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new ProviderError(
      `${providerName} returned unparseable JSON: ${cleaned.slice(0, 200)}`,
      { retryable: true }
    );
  }
}

/* ------------------------------------------------------------------ Gemini */

function geminiProvider({
  id,
  model,
  apiKey,
  minIntervalMs = Number(process.env.GEMINI_MIN_INTERVAL_MS || 7000),
}) {
  const pace = createPacer(minIntervalMs);
  const schema = toGeminiSchema();

  return {
    id,
    model,
    async listModels() {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": apiKey } }
      );
      const text = await res.text();
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      return (data.models || []).map((m) => (m.name || "").replace(/^models\//, ""));
    },
    async complete({ system, user }) {
      await pace();
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const data = await postJson(url, {
        headers: { "x-goog-api-key": apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: schema,
            // Generous: on thinking-capable models reasoning tokens count here,
            // and a MAX_TOKENS cutoff would truncate the JSON mid-object.
            maxOutputTokens: 8192,
          },
        },
      });

      const candidate = data?.candidates?.[0];
      if (!candidate) {
        const blocked = data?.promptFeedback?.blockReason;
        throw new ProviderError(
          blocked ? `blocked by safety filter (${blocked})` : "no candidate returned",
          { retryable: !blocked }
        );
      }
      if (candidate.finishReason === "MAX_TOKENS") {
        throw new ProviderError("hit MAX_TOKENS before completing JSON", {
          retryable: true,
        });
      }
      // Thinking models emit reasoning as parts flagged `thought` — skip those.
      const text = (candidate.content?.parts || [])
        .filter((p) => p.thought !== true && typeof p.text === "string")
        .map((p) => p.text)
        .join("");

      return parseModelJson(text, id);
    },
  };
}

/* ------------------------------------------- OpenAI-compatible (Groq, Cerebras) */

function openAiCompatibleProvider({
  id,
  model,
  apiKey,
  baseUrl,
  minIntervalMs = 2500,
}) {
  const pace = createPacer(minIntervalMs);
  // Flipped off permanently once a provider rejects strict json_schema, so we
  // pay the discovery cost at most once per run.
  let supportsJsonSchema = true;

  function buildBody({ system, user, useSchema }) {
    return {
      model,
      temperature: 0,
      max_completion_tokens: 4096,
      response_format: useSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: "manuscript_event",
              strict: true,
              schema: STRICT_JSON_SCHEMA,
            },
          }
        : { type: "json_object" },
      messages: [
        {
          role: "system",
          content: useSchema
            ? system
            : `${system}\n\nRespond with a single JSON object matching this schema:\n${JSON.stringify(
                STRICT_JSON_SCHEMA
              )}`,
        },
        { role: "user", content: user },
      ],
    };
  }

  return {
    id,
    model,
    /** Diagnostic: what model ids this key can actually reach. */
    async listModels() {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      return (data.data || []).map((m) => m.id);
    },
    async complete({ system, user }) {
      await pace();
      const send = (useSchema) =>
        postJson(`${baseUrl}/chat/completions`, {
          headers: { authorization: `Bearer ${apiKey}` },
          body: buildBody({ system, user, useSchema }),
        });

      let data;
      try {
        data = await send(supportsJsonSchema);
      } catch (err) {
        // A 400 here usually means this model has no strict-schema support.
        if (supportsJsonSchema && err.status === 400) {
          supportsJsonSchema = false;
          await pace();
          data = await send(false);
        } else {
          throw err;
        }
      }

      const choice = data?.choices?.[0];
      if (!choice?.message) {
        throw new ProviderError("no choices returned", { retryable: true });
      }
      if (choice.finish_reason === "length") {
        throw new ProviderError("hit token limit before completing JSON", {
          retryable: true,
        });
      }
      return parseModelJson(choice.message.content, id);
    },
  };
}

/* ------------------------------------------------------------------ registry */

/**
 * Build the provider chain from whichever API keys are present.
 *
 * Order is deliberate — strongest free model first, then the no-training
 * inference providers as fallbacks. A chain of one works fine; the app only
 * needs a single key to run.
 */
export function buildProviderChain(env = process.env) {
  const chain = [];

  if (env.GEMINI_API_KEY) {
    chain.push(
      geminiProvider({
        id: "gemini-3.7-flash",
        model: env.GEMINI_MODEL || "gemini-3.7-flash",
        apiKey: env.GEMINI_API_KEY,
      })
    );
    // Second, independent Gemini generation — used as a cross-check and as a
    // landing spot if the newest model is not on the free tier for this account.
    chain.push(
      geminiProvider({
        id: "gemini-2.5-flash",
        model: env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash",
        apiKey: env.GEMINI_API_KEY,
      })
    );
  }

  if (env.CEREBRAS_API_KEY) {
    chain.push(
      openAiCompatibleProvider({
        id: "cerebras",
        model: env.CEREBRAS_MODEL || "gpt-oss-120b",
        apiKey: env.CEREBRAS_API_KEY,
        baseUrl: "https://api.cerebras.ai/v1",
      })
    );
  }

  if (env.GROQ_API_KEY) {
    chain.push(
      openAiCompatibleProvider({
        id: "groq",
        model: env.GROQ_MODEL || "openai/gpt-oss-120b",
        apiKey: env.GROQ_API_KEY,
        baseUrl: "https://api.groq.com/openai/v1",
      })
    );
  }

  // CLASSIFIER_PROVIDERS restricts the chain to a comma-separated allowlist of
  // provider ids, in the order given. Use it to exclude a provider whose data
  // policy you don't want (e.g. CLASSIFIER_PROVIDERS=cerebras,groq keeps email
  // text away from Gemini's free tier) without deleting its API key.
  const allowlist = (env.CLASSIFIER_PROVIDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowlist.length) return chain;

  const filtered = allowlist
    .map((id) => chain.find((p) => p.id === id))
    .filter(Boolean);
  if (!filtered.length) {
    throw new ProviderError(
      `CLASSIFIER_PROVIDERS="${env.CLASSIFIER_PROVIDERS}" matched no configured provider. ` +
        `Available: ${chain.map((p) => p.id).join(", ") || "(none)"}`
    );
  }
  return filtered;
}

/**
 * Run a prompt against the chain, trying each provider in turn and retrying
 * retryable failures with backoff. `skipIds` lets the verification pass insist
 * on a genuinely different model than the one being checked.
 */
export async function completeWithChain(
  chain,
  { system, user, skipIds = [], attemptsPerProvider = 2 }
) {
  const usable = chain.filter((p) => !skipIds.includes(p.id));
  if (!usable.length) {
    throw new ProviderError("no provider available for this request");
  }

  const failures = [];
  let allRateLimited = true;
  for (const provider of usable) {
    for (let attempt = 1; attempt <= attemptsPerProvider; attempt++) {
      try {
        const raw = await provider.complete({ system, user });
        return { raw, providerId: provider.id, model: provider.model };
      } catch (err) {
        failures.push(`${provider.id}: ${err.message}`);
        if (!err.rateLimited) allRateLimited = false;
        const lastAttempt = attempt === attemptsPerProvider;
        if (!err.retryable || lastAttempt) break;
        // Respect the provider's stated backoff when it gives one.
        await sleep(Math.min(err.retryAfterMs ?? 2000 * attempt, 30000));
      }
    }
  }

  // If every failure was a quota ceiling, say so: the caller should wait for the
  // window to reopen rather than treat the email as unclassifiable.
  throw new ProviderError(
    `all providers failed — ${failures.join(" | ")}`,
    { retryable: true, rateLimited: allRateLimited }
  );
}

export { ProviderError };

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
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError(
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      { retryable, status: response.status }
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

function geminiProvider({ id, model, apiKey, minIntervalMs = 4500 }) {
  const pace = createPacer(minIntervalMs);
  const schema = toGeminiSchema();

  return {
    id,
    model,
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
        model: env.GROQ_MODEL || "moonshotai/kimi-k2-instruct-0905",
        apiKey: env.GROQ_API_KEY,
        baseUrl: "https://api.groq.com/openai/v1",
      })
    );
  }

  return chain;
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
  for (const provider of usable) {
    for (let attempt = 1; attempt <= attemptsPerProvider; attempt++) {
      try {
        const raw = await provider.complete({ system, user });
        return { raw, providerId: provider.id, model: provider.model };
      } catch (err) {
        failures.push(`${provider.id}: ${err.message}`);
        const lastAttempt = attempt === attemptsPerProvider;
        if (!err.retryable || lastAttempt) break;
        await sleep(2000 * attempt);
      }
    }
  }

  throw new ProviderError(
    `all providers failed — ${failures.join(" | ")}`,
    { retryable: true }
  );
}

export { ProviderError };

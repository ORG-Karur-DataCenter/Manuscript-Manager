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
    {
      retryable = false, status = null, rateLimited = false,
      retryAfterMs = null, deferrable = null,
    } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    // A quota ceiling is not the email's fault: callers use this to retry the
    // message later instead of counting it toward a give-up budget.
    this.rateLimited = rateLimited;
    // Broader than rateLimited: true when nothing about the failure was a
    // verdict on the email, so the caller should defer it without penalty.
    // Defaults to whatever `retryable` says, since a single retryable failure
    // is by definition not the email's fault either.
    this.deferrable = deferrable ?? retryable;
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

    /*
     * `deferrable` is a different question from `retryable`, and conflating
     * them cost real mail twice.
     *
     * retryable asks: is trying this again likely to work? A 402 "payment
     * required" fails that -- retrying it is pure waste.
     *
     * deferrable asks: was this failure about the EMAIL? A 402 fails that too,
     * and that is the point. Your billing status, your API key and your daily
     * quota are all facts about the account, and none of them says the message
     * is unclassifiable. Counting them against the email's three-strike budget
     * retires perfectly good mail into the review queue during an outage that
     * has nothing to do with it.
     *
     * That is precisely what happened: an account with no Cerebras quota
     * returned 402 on every message, and because 402 is neither 429 nor 5xx,
     * every amendment that arrived during it took a strike.
     *
     * Only a failure the CONTENT provoked -- a malformed answer, a rejected
     * request body -- is evidence about the message.
     */
    const aboutTheAccount =
      [401, 402, 403, 407, 408, 429].includes(response.status) || response.status >= 500;

    throw new ProviderError(
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      {
        retryable,
        status: response.status,
        rateLimited,
        deferrable: aboutTheAccount,
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

  /*
   * OUTPUT BUDGET. Groq's daily token allowance appears to count what a
   * request RESERVES, not what it uses: a call whose prompt is ~2,600 tokens
   * was billed as 7,117 requested, and 2,600 + 4,096 accounts for the gap.
   * (Groq's public docs do not state this, so it is inference from the
   * arithmetic rather than something confirmed.)
   *
   * The answer is one small JSON object -- a verdict, a few identifiers and a
   * sentence of note, comfortably under 300 tokens. Reserving 4,096 therefore
   * threw away most of a 200,000/day budget on room never used, and 40 new
   * emails in a morning exhausted it.
   *
   * The low default is safe because a cutoff is detected rather than parsed:
   * finish_reason "length" escalates to the ceiling and retries once, so a
   * rare verbose message still gets what it needs and the common case stays
   * cheap. If the inference above is wrong, this costs nothing -- the room was
   * never used either way.
   */
  const OUTPUT_TOKENS = Number(process.env.CLASSIFY_MAX_OUTPUT_TOKENS || 1024);
  const OUTPUT_CEILING = 4096;

  function buildBody({ system, user, useSchema, maxOutput = OUTPUT_TOKENS }) {
    return {
      model,
      temperature: 0,
      max_completion_tokens: maxOutput,
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
      const send = (useSchema, maxOutput) =>
        postJson(`${baseUrl}/chat/completions`, {
          headers: { authorization: `Bearer ${apiKey}` },
          body: buildBody({ system, user, useSchema, maxOutput }),
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

      let choice = data?.choices?.[0];
      if (!choice?.message) {
        throw new ProviderError("no choices returned", { retryable: true });
      }
      // Truncated JSON is unparseable, so a cutoff is answered with room
      // rather than an error. Once, and only upward: this is what lets the
      // default budget be small without risking the occasional long reply.
      if (choice.finish_reason === "length" && OUTPUT_TOKENS < OUTPUT_CEILING) {
        await pace();
        data = await send(supportsJsonSchema, OUTPUT_CEILING);
        choice = data?.choices?.[0];
        if (!choice?.message) {
          throw new ProviderError("no choices returned on retry", { retryable: true });
        }
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

  // A named provider with no key is dropped silently by the filter below, so
  // say so. Naming one and forgetting its secret looks identical to not
  // wanting it, and the only visible symptom is quota running out sooner than
  // expected on the providers that did load.
  const missing = allowlist.filter((id) => !chain.some((p) => p.id === id));
  if (missing.length) {
    console.warn(
      `CLASSIFIER_PROVIDERS names ${missing.join(", ")}, but no API key is set for ` +
      `${missing.length > 1 ? "those" : "that"}, so ${missing.length > 1 ? "they are" : "it is"} ` +
      `not in the chain. Configured: ${chain.map((p) => p.id).join(", ") || "(none)"}.`
    );
  }

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
  // Whether every failure was a "come back later" rather than a verdict on
  // this email. See the throw at the end for why this is not the same test.
  let allTransient = true;
  for (const provider of usable) {
    for (let attempt = 1; attempt <= attemptsPerProvider; attempt++) {
      try {
        const raw = await provider.complete({ system, user });
        return { raw, providerId: provider.id, model: provider.model };
      } catch (err) {
        failures.push(`${provider.id}: ${err.message}`);
        if (!err.rateLimited) allRateLimited = false;
        if (!(err.deferrable ?? err.retryable)) allTransient = false;
        const lastAttempt = attempt === attemptsPerProvider;
        if (!err.retryable || lastAttempt) break;
        // Respect the provider's stated backoff when it gives one.
        await sleep(Math.min(err.retryAfterMs ?? 2000 * attempt, 30000));
      }
    }
  }

  /*
   * `deferrable` is the flag that matters, and it is deliberately NOT
   * `allRateLimited`.
   *
   * Requiring every failure to be a 429 was too strict, and quietly cost real
   * mail. A run that saw groq 429, groq 429, gemini 503, gemini 429 has hit
   * nothing but temporary walls -- yet the single 503 made allRateLimited
   * false, so the caller counted it as a failed attempt on the email itself.
   * Three such runs during one bad afternoon retired a perfectly classifiable
   * amendment into the review queue, and every one of the items stranded there
   * had exactly that mixture of 429s and 503s.
   *
   * A 503 says the model is busy. A 429 says the quota is spent. Neither says
   * anything about this email. Only a NON-retryable failure -- a malformed
   * response, a 400, a bad key -- is evidence about the message, and that is
   * what `retryable` already distinguishes.
   */
  throw new ProviderError(
    `all providers failed — ${failures.join(" | ")}`,
    { retryable: true, rateLimited: allRateLimited, deferrable: allTransient }
  );
}

export { ProviderError };

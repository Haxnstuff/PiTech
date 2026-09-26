// PiTech by Haxnstuff
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function pricePerMillion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number((number * 1_000_000).toFixed(12)) : 0;
}

export function openRouterModelToPi(raw) {
  if (!raw || typeof raw.id !== "string" || !raw.id.trim()) return null;

  const architecture = raw.architecture && typeof raw.architecture === "object" ? raw.architecture : {};
  const modalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  const modalityText = typeof architecture.modality === "string" ? architecture.modality : "";
  const input = ["text"];
  if (modalities.includes("image") || modalityText.includes("image")) input.push("image");

  const contextWindow = positiveNumber(
    raw.top_provider?.context_length,
    positiveNumber(raw.context_length, 128_000),
  );
  const maxTokens = positiveNumber(raw.top_provider?.max_completion_tokens, Math.min(contextWindow, 16_384));
  const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {};
  const supported = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];

  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
    input,
    cost: {
      input: pricePerMillion(pricing.prompt),
      output: pricePerMillion(pricing.completion),
      cacheRead: pricePerMillion(pricing.input_cache_read),
      cacheWrite: pricePerMillion(pricing.input_cache_write),
    },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  };
}

export async function refreshOpenRouterCatalog(context, fetchImpl = fetch) {
  const stored = context.stored;
  const storedModels = stored?.source === "openrouter-api" && Array.isArray(stored.models) ? stored.models : undefined;
  if (!context.allowNetwork) return storedModels;
  if (storedModels && !context.force && Date.now() - (stored.checkedAt ?? 0) < CATALOG_MAX_AGE_MS) {
    return storedModels;
  }

  const credential = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
  if (!credential) return storedModels;

  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { accept: "application/json", Authorization: `Bearer ${credential}` },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`OpenRouter model request failed: ${response.status}`);

  const payload = await response.json();
  const models = [...new Map(
    (Array.isArray(payload?.data) ? payload.data : [])
      .map(openRouterModelToPi)
      .filter(Boolean)
      .map((model) => [model.id, model]),
  ).values()];
  if (!models.length) throw new Error("OpenRouter returned no models");

  const checkedAt = Date.now();
  await context.publish({
    persist: {
      source: "openrouter-api",
      models: models.map((model) => ({ ...model, provider: "openrouter" })),
      checkedAt,
      lastModified: checkedAt,
      etag: response.headers?.get?.("etag") ?? undefined,
    },
  });
  return models;
}

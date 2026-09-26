// PiTech by Haxnstuff
import assert from "node:assert/strict";
import test from "node:test";
import { openRouterModelToPi, refreshOpenRouterCatalog } from "../pi/scripts/openrouter-catalog.mjs";

test("maps an OpenRouter catalog model into a selectable Pi model", () => {
  const model = openRouterModelToPi({
    id: "vendor/new-model",
    name: "Vendor New Model",
    context_length: 200000,
    architecture: { input_modalities: ["text", "image"] },
    top_provider: { context_length: 131072, max_completion_tokens: 32768 },
    pricing: {
      prompt: "0.000001",
      completion: "0.000003",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000004",
    },
    supported_parameters: ["reasoning"],
  });

  assert.deepEqual(model, {
    id: "vendor/new-model",
    name: "Vendor New Model",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0.4 },
    contextWindow: 131072,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
  });
});

test("refreshes the authenticated OpenRouter catalog and persists it", async () => {
  let published;
  const models = await refreshOpenRouterCatalog({
    allowNetwork: true,
    credential: { type: "api_key", key: "test-token" },
    signal: new AbortController().signal,
    publish: async (publication) => {
      published = publication.persist;
      return true;
    },
  }, async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return new Response(JSON.stringify({
      data: [{
        id: "vendor/new-model",
        name: "Vendor New Model",
        context_length: 1000,
        architecture: { input_modalities: ["text"] },
        top_provider: { context_length: 900, max_completion_tokens: 100 },
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: [],
      }],
    }), { status: 200 });
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "vendor/new-model");
  assert.equal(published.source, "openrouter-api");
  assert.equal(published.models[0].id, "vendor/new-model");
  assert.equal(published.models[0].provider, "openrouter");
});

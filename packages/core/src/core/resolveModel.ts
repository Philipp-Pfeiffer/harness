import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ConfigModel } from "../config.js";

const runtimeGetModel = getModel as (
  provider: string,
  modelId: string,
) => Model<Api> | undefined;

const runtimeGetProviders = getProviders as () => string[];

const runtimeGetModels = getModels as (provider: string) => Model<Api>[];

export type ResolvedModel = Model<Api> & { apiKey?: string; inlineThinking?: boolean; supportsVision?: boolean };

export function getApiKey(model: Model<Api>): string | undefined {
  return (model as ResolvedModel).apiKey;
}

export function resolveModel(
  providerStr: string,
  modelStr: string,
): ResolvedModel {
  const knownProviders = runtimeGetProviders();
  if (!knownProviders.includes(providerStr)) {
    throw new Error(
      `Unknown provider '${providerStr}'. Known providers: ${knownProviders.join(", ")}`,
    );
  }

  const knownModels = runtimeGetModels(providerStr);
  const knownModelIds = knownModels.map((m) => m.id);
  if (!knownModelIds.includes(modelStr)) {
    throw new Error(
      `Unknown model '${modelStr}' for provider '${providerStr}'. Known models: ${knownModelIds.join(", ")}`,
    );
  }

  const model = runtimeGetModel(providerStr, modelStr);
  if (!model) {
    throw new Error(
      `Model '${modelStr}' not found for provider '${providerStr}'.`,
    );
  }

  return model as ResolvedModel;
}

function buildCustomModel(config: ConfigModel): ResolvedModel {
  if (!config.baseUrl) {
    throw new Error(
      `Custom provider '${config.provider}' requires a baseUrl. Set it on the model or in providers["${config.provider}"].baseUrl.`,
    );
  }

  const api = config.api ?? "openai-completions";
  if (api !== "openai-completions" && api !== "openai-responses") {
    throw new Error(
      `Unsupported api '${api}' for custom provider '${config.provider}'. Use 'openai-completions' or 'openai-responses'.`,
    );
  }

  return {
    id: config.model,
    name: config.alias ?? config.model,
    api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.input ?? ["text"],
    cost: {
      input: config.cost?.input ?? 0,
      output: config.cost?.output ?? 0,
      cacheRead: config.cost?.cacheRead ?? 0,
      cacheWrite: config.cost?.cacheWrite ?? 0,
    },
    contextWindow: config.contextWindow ?? 128000,
    maxTokens: config.maxTokens ?? 4096,
    apiKey: config.apiKey,
    inlineThinking: config.inlineThinking ?? false,
    supportsVision: config.supportsVision,
  } as ResolvedModel;
}

export function resolveModelFromConfig(
  config: ConfigModel,
): ResolvedModel {
  const knownProviders = runtimeGetProviders();
  const hasCustomEndpoint =
    config.baseUrl !== undefined ||
    config.apiKey !== undefined ||
    config.api !== undefined;

  if (knownProviders.includes(config.provider) && !hasCustomEndpoint) {
    return resolveModel(config.provider, config.model);
  }

  return buildCustomModel(config);
}

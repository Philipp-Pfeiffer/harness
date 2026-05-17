import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

const runtimeGetModel = getModel as (
  provider: string,
  modelId: string,
) => Model<Api> | undefined;

const runtimeGetProviders = getProviders as () => string[];

const runtimeGetModels = getModels as (provider: string) => Model<Api>[];

export function resolveModel(providerStr: string, modelStr: string): Model<Api> {
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

  return model;
}

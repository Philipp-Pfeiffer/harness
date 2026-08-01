import type { ConfigModel, ImageConfig } from "../config.js";
import { isOpenRouterPresetRef, parseModelRef } from "../browser/config.js";
import {
  resolveModel,
  resolveModelFromConfig,
  type ResolvedModel,
} from "../core/resolveModel.js";

export const DEFAULT_IMAGE_MODEL = "@preset/vision";
export const DEFAULT_IMAGE_MAX_TOKENS = 4096;

export interface ResolvedImageConfig {
  model: string;
  maxTokens: number;
}

export function resolveImageConfig(config?: ImageConfig): ResolvedImageConfig {
  return {
    model: config?.model ?? DEFAULT_IMAGE_MODEL,
    maxTokens: config?.maxTokens ?? DEFAULT_IMAGE_MAX_TOKENS,
  };
}

/** Resolves a model reference from config, including OpenRouter @preset/ refs. */
export function resolveImageModel(
  modelRef: string,
  models?: ConfigModel[],
): ResolvedModel {
  if (isOpenRouterPresetRef(modelRef)) {
    const fromConfig = models?.find((m) => m.model === modelRef);
    if (!fromConfig) {
      throw new Error(
        `Unknown OpenRouter preset "${modelRef}". Add it to config.models in $HARNESS_HOME/config.json.`,
      );
    }
    return resolveModelFromConfig(fromConfig);
  }
  const { provider, model: modelId } = parseModelRef(modelRef);
  const fromConfig = models?.find((m) => m.provider === provider && m.model === modelId);
  if (fromConfig) {
    return resolveModelFromConfig(fromConfig);
  }
  return resolveModel(provider, modelId);
}

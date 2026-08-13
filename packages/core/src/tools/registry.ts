import type { Tool } from "./types.js";
import type { MemoryBackend } from "../core/memoryBackend.js";
import type { WebConfig, BrowserConfig, ImageConfig, ConfigModel } from "../config.js";
import type { SkillRecord } from "../skills/types.js";
import type { FindSkillToolOptions } from "./findSkill.js";
import { readFileTool } from "./readFile.js";
import { execTool } from "./exec.js";
import { processTool } from "./process.js";
import { writeTool } from "./write_file.js";
import { editTool } from "./edit_file.js";
import { createSearchMemoryTool } from "./searchMemory.js";
import { createWebSearchTool } from "./web_search.js";
import { createWebFetchTool } from "./web_fetch.js";
import { createLoadSkillTool } from "./loadSkill.js";
import { createFindSkillTool } from "./findSkill.js";
import { sendFileTool } from "./send_file.js";
import { sendStickerTool } from "./send_sticker.js";
import { requestRestartTool } from "./requestRestart.js";
import { callUserTool } from "./call_user.js";
import { reportToMainSessionTool } from "./report_to_main_session.js";
import { createBrowserTool } from "./browser.js";
import { createImageTool } from "./image.js";

export interface LoadToolsOptions {
  memoryBackend?: MemoryBackend;
  webConfig?: WebConfig;
  /** Loaded skill records for load_skill / find_skill tools. */
  skills?: SkillRecord[];
  /** Skills directory path (for telemetry). */
  skillsDir?: string;
  /** Optional QMD store for find_skill search. */
  findSkillStore?: FindSkillToolOptions["store"];
  /** Browser subsystem options. When downloadsBaseDir is set, registers the `browser` tool. */
  browser?: {
    config?: BrowserConfig;
    defaultModel?: ConfigModel;
    models?: ConfigModel[];
    downloadsBaseDir: string;
    browserRunsDir: string;
    /** System event bus for async browser completion notifications. */
    injectSystemEvent?: (event: { origin: string; text: string }) => void;
    /** Max concurrent async browser tasks (default 2). */
    maxConcurrent?: number;
    /** Per-task timeout in ms (default 30 min). */
    taskTimeoutMs?: number;
  };
  /** Vision model options. When models are set, registers the `image` tool. */
  image?: {
    config?: ImageConfig;
    defaultModel?: ConfigModel;
    models?: ConfigModel[];
  };
}

export function loadTools(opts?: LoadToolsOptions): Tool[];
/** @deprecated Use loadTools with options object. */
export function loadTools(memoryBackend?: MemoryBackend, webConfig?: WebConfig): Tool[];
export function loadTools(
  arg1?: MemoryBackend | LoadToolsOptions,
  webConfig?: WebConfig,
): Tool[] {
  // Normalize to options object (backward compat with old signature)
  const opts: LoadToolsOptions =
    arg1 !== undefined &&
    typeof arg1 === "object" &&
    ("memoryBackend" in arg1 ||
      "webConfig" in arg1 ||
      "skills" in arg1 ||
      "skillsDir" in arg1 ||
      "findSkillStore" in arg1 ||
      "browser" in arg1 ||
      "image" in arg1)
      ? (arg1 as LoadToolsOptions)
      : {
          memoryBackend: arg1 as MemoryBackend | undefined,
          webConfig,
        };

  const tools: Tool[] = [
    readFileTool,
    execTool,
    processTool,
    writeTool,
    editTool,
    sendFileTool,
    sendStickerTool,
    requestRestartTool,
    callUserTool,
    reportToMainSessionTool,
    createSearchMemoryTool(opts.memoryBackend),
    createWebSearchTool(opts.webConfig),
    createWebFetchTool(opts.webConfig),
  ];

  if (opts.skills && opts.skills.length > 0) {
    tools.push(
      createLoadSkillTool(opts.skills, opts.skillsDir ?? ""),
      createFindSkillTool(opts.skills, { store: opts.findSkillStore }),
    );
  }

  if (opts.browser?.downloadsBaseDir) {
    tools.push(createBrowserTool({
      browserConfig: opts.browser.config,
      defaultModel: opts.browser.defaultModel,
      models: opts.browser.models,
      downloadsBaseDir: opts.browser.downloadsBaseDir,
      browserRunsDir: opts.browser.browserRunsDir,
      injectSystemEvent: opts.browser.injectSystemEvent,
      maxConcurrent: opts.browser.maxConcurrent,
      taskTimeoutMs: opts.browser.taskTimeoutMs,
    }));
  }

  if (opts.image?.models) {
    tools.push(createImageTool({
      imageConfig: opts.image.config,
      defaultModel: opts.image.defaultModel,
      models: opts.image.models,
      webConfig: opts.webConfig,
    }));
  }

  return tools;
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

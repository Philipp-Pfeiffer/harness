import { Type } from "@sinclair/typebox";
import path from "node:path";
import { chmod } from "node:fs/promises";
import type { Tool } from "../tools/types.js";
import { ok, err } from "../tools/types.js";
import type { BrowserSubAgentContext } from "./context.js";
import { formatSnapshotToolResult } from "./engine.js";
import { BrowserUrlError } from "./urlSecurity.js";
import { BrowserSessionError } from "./engine.js";
import { resolveSandboxPath, verifyDownload, writeSandboxFile } from "./sandbox.js";
import type { BrowserReport } from "./types.js";
import type { BrowserSessionOptions } from "./types.js";

const NavigateArgs = Type.Object({
  url: Type.String({ minLength: 1, description: "Destination URL (http/https)." }),
});

const SnapshotArgs = Type.Object({});

const ClickArgs = Type.Object({
  ref: Type.Integer({ minimum: 1, description: "Element ref from browser_snapshot." }),
});

const TypeArgs = Type.Object({
  ref: Type.Integer({ minimum: 1, description: "Element ref from browser_snapshot." }),
  text: Type.String({ description: "Text to type." }),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
});

const ScreenshotArgs = Type.Object({
  fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
});

const TabsArgs = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("new"),
    Type.Literal("select"),
    Type.Literal("close"),
  ]),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Tab index for select/close." })),
  url: Type.Optional(Type.String({ description: "Optional URL when opening a new tab." })),
});

const DownloadArgs = Type.Object({
  ref: Type.Optional(Type.Integer({ minimum: 1, description: "Element ref that triggers download." })),
  url: Type.Optional(Type.String({ description: "Direct download URL (http/https)." })),
  filename: Type.Optional(Type.String({ description: "Desired filename (basename only)." })),
});

const TakeNoteArgs = Type.Object({
  text: Type.String({ minLength: 1, description: "Note text to remember." }),
});

const SubmitReportArgs = Type.Object({
  goalAchieved: Type.Boolean({ description: "Whether the stated goal was achieved." }),
  result: Type.String({ description: "Main result content (markdown or JSON per task)." }),
  files: Type.Optional(Type.Array(Type.String({ description: "Paths of downloaded files." }))),
  visitedUrls: Type.Optional(Type.Array(Type.String({ description: "URLs visited during session." }))),
  blockers: Type.Optional(Type.String({ description: "What blocked progress, if any." })),
});

function mutatingResult(ctx: BrowserSubAgentContext, prefix: string): Promise<ReturnType<typeof ok>> {
  return ctx.engine.takeSnapshot().then((snapshot) => {
    return ok(`${prefix}\n\n${formatSnapshotToolResult(snapshot)}`);
  });
}

function handleBrowserError(error: unknown): ReturnType<typeof err> {
  if (error instanceof BrowserUrlError || error instanceof BrowserSessionError) {
    return err(error.message);
  }
  return err(error instanceof Error ? error.message : String(error));
}

export function createBrowserSubAgentTools(
  ctx: BrowserSubAgentContext,
  options: BrowserSessionOptions,
): Tool[] {
  const navigateTool: Tool<typeof NavigateArgs> = {
    name: "browser_navigate",
    description: "Navigate the active tab to a URL. Only http/https public URLs are allowed.",
    parameters: NavigateArgs,
    async execute(args) {
      try {
        await ctx.engine.navigate(args.url);
        return mutatingResult(ctx, `Navigated to ${args.url}`);
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const snapshotTool: Tool<typeof SnapshotArgs> = {
    name: "browser_snapshot",
    description:
      "Capture an accessibility-oriented snapshot of the active page with numbered element refs " +
      "(e.g. [12] link \"Login\"). Use refs with browser_click and browser_type. Token-capped.",
    parameters: SnapshotArgs,
    async execute() {
      try {
        const snapshot = await ctx.engine.takeSnapshot();
        return ok(formatSnapshotToolResult(snapshot));
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const clickTool: Tool<typeof ClickArgs> = {
    name: "browser_click",
    description: "Click an element by its ref number from the latest browser_snapshot.",
    parameters: ClickArgs,
    conflictKey: () => "browser-mutate",
    async execute(args) {
      try {
        await ctx.engine.clickRef(args.ref);
        return mutatingResult(ctx, `Clicked [${args.ref}]`);
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const typeTool: Tool<typeof TypeArgs> = {
    name: "browser_type",
    description: "Type text into an input element by ref. Optionally press Enter after typing.",
    parameters: TypeArgs,
    conflictKey: () => "browser-mutate",
    async execute(args) {
      try {
        await ctx.engine.typeRef(args.ref, args.text, args.submit);
        return mutatingResult(ctx, `Typed into [${args.ref}]`);
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const screenshotTool: Tool<typeof ScreenshotArgs> = {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the active page. Saved to the session download directory.",
    parameters: ScreenshotArgs,
    async execute(args) {
      try {
        const buffer = await ctx.engine.screenshot(args.fullPage ?? false);
        const filename = `screenshot-${Date.now()}.png`;
        const filePath = await writeSandboxFile(
          ctx.downloadDir,
          filename,
          buffer,
          options.maxDownloadBytes,
        );
        ctx.downloadedFiles.push(filePath);
        return ok(`Screenshot saved: ${filePath}`);
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const tabsTool: Tool<typeof TabsArgs> = {
    name: "browser_tabs",
    description: "List, create, select, or close browser tabs.",
    parameters: TabsArgs,
    async execute(args) {
      try {
        switch (args.action) {
          case "list": {
            const tabs = await ctx.engine.listTabs();
            const lines = tabs.map(
              (t) => `${t.active ? "*" : " "} [${t.index}] ${t.title || "(no title)"} — ${t.url}`,
            );
            return ok(lines.join("\n") || "No tabs");
          }
          case "new":
            await ctx.engine.newTab(args.url);
            return mutatingResult(ctx, "Opened new tab");
          case "select":
            if (args.index === undefined) return err("index is required for select");
            await ctx.engine.selectTab(args.index);
            return mutatingResult(ctx, `Selected tab ${args.index}`);
          case "close":
            await ctx.engine.closeTab(args.index);
            return mutatingResult(ctx, "Closed tab");
          default:
            return err(`Unknown action: ${String(args.action)}`);
        }
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const downloadTool: Tool<typeof DownloadArgs> = {
    name: "browser_download",
    description:
      "Download a file by clicking an element ref or by direct URL. " +
      "Files are saved to the session sandbox only.",
    parameters: DownloadArgs,
    conflictKey: () => "browser-mutate",
    async execute(args) {
      if (!args.ref && !args.url) {
        return err("Provide either ref or url");
      }
      if (args.ref && args.url) {
        return err("Provide ref or url, not both");
      }

      const basename = args.filename
        ? path.basename(args.filename)
        : `download-${Date.now()}`;
      const destPath = resolveSandboxPath(ctx.downloadDir, basename);

      try {
        if (args.ref) {
          await ctx.engine.downloadByRef(args.ref, destPath);
        } else if (args.url) {
          await ctx.engine.downloadByUrl(args.url, destPath);
        }
        await verifyDownload(destPath, options.maxDownloadBytes);
        await chmod(destPath, 0o644);
        ctx.downloadedFiles.push(destPath);
        return mutatingResult(ctx, `Downloaded: ${destPath}`);
      } catch (error) {
        return handleBrowserError(error);
      }
    },
  };

  const takeNoteTool: Tool<typeof TakeNoteArgs> = {
    name: "take_note",
    description:
      "Buffer intermediate findings. Notes survive snapshot flooding and are appended to the final report.",
    parameters: TakeNoteArgs,
    async execute(args) {
      ctx.addNote(args.text);
      return ok("Note saved.");
    },
  };

  const submitReportTool: Tool<typeof SubmitReportArgs> = {
    name: "submit_report",
    description:
      "Submit the final browser session report. This is the ONLY way to finish the session. " +
      "Call once when done or structurally stuck.",
    parameters: SubmitReportArgs,
    async execute(args) {
      const report: BrowserReport = {
        goalAchieved: args.goalAchieved,
        result: args.result,
        files: args.files ?? [...ctx.downloadedFiles],
        visitedUrls: args.visitedUrls ?? ctx.engine.getVisitedUrls(),
        blockers: args.blockers,
        notes: ctx.notes.length > 0 ? ctx.notes.join("\n") : undefined,
      };
      ctx.complete(report);
      return ok("Report submitted. Session ending.");
    },
  };

  return [
    navigateTool,
    snapshotTool,
    clickTool,
    typeTool,
    screenshotTool,
    tabsTool,
    downloadTool,
    takeNoteTool,
    submitReportTool,
  ];
}

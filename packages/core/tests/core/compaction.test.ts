import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { complete, stream, getModel } from "@mariozechner/pi-ai";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";
import {
  estimateTokens,
  estimateContextOverhead,
  findSplitPoint,
  shouldCompact,
  compactSession,
  DEFAULT_COMPACTION_THRESHOLD,
} from "../../src/core/compaction.js";
import { resolveHarnessPaths } from "../../src/config/paths.js";
import { createAgent } from "../../src/core/agent.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: vi.fn(),
    stream: vi.fn(),
  };
});

const model = getModel("minimax", "MiniMax-M2.7");

function makeUserMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>, stopReason: "stop" | "toolUse" = "stop") {
  return {
    role: "assistant" as const,
    content,
    stopReason,
    provider: "minimax" as const,
    api: "anthropic-messages" as const,
    model: "MiniMax-M2.7",
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function makeToolResultMessage(toolCallId: string, toolName: string, result: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: result }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makePaths() {
  const dir = mkdtempSync(join(tmpdir(), "harness-compaction-test-"));
  return resolveHarnessPaths({ home: join(dir, "harness") });
}

function mockCompleteResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    provider: "minimax",
    api: "anthropic-messages",
    model: "MiniMax-M2.7",
    usage: { input: 10, output: 20, totalTokens: 30, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

describe("compaction", () => {
  beforeEach(() => {
    vi.mocked(complete).mockReset();
  });

  afterEach(() => {
    vi.mocked(complete).mockReset();
  });

  describe("estimateTokens", () => {
    it("returns 0 for empty messages", () => {
      expect(estimateTokens([])).toBe(0);
    });

    it("counts string content", () => {
      const msgs = [makeUserMessage("hello world")];
      const tokens = estimateTokens(msgs);
      expect(tokens).toBeGreaterThan(0);
      // "hello world" = 11 chars + 3 overhead = 14 chars / 4 = 4 tokens
      expect(tokens).toBe(4);
    });

    it("counts assistant with toolCall content", () => {
      const msgs = [
        makeAssistantMessage([
          { type: "toolCall", id: "tc1", name: "readFile", arguments: { path: "/tmp/test.ts" } },
        ], "toolUse"),
      ];
      const tokens = estimateTokens(msgs);
      expect(tokens).toBeGreaterThan(0);
    });

    it("counts toolResult messages", () => {
      const msgs = [
        makeToolResultMessage("tc1", "readFile", "file content here"),
      ];
      const tokens = estimateTokens(msgs);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe("shouldCompact", () => {
    it("returns false when tokens are below threshold", () => {
      const msgs = [makeUserMessage("short")];
      expect(shouldCompact(msgs, model, 0.8)).toBe(false);
    });

    it("returns true when tokens exceed threshold", () => {
      // Create a large message that exceeds 80% of the model's context window
      // estimateTokens uses ~4 chars/token, so we need enough to exceed 0.8 * contextWindow
      const bigContent = "x".repeat(2_000_000);
      const msgs = [makeUserMessage(bigContent)];
      expect(shouldCompact(msgs, model, 0.8)).toBe(true);
    });

    it("uses default threshold of 0.8", () => {
      expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.8);
    });

    it("F5: includes system prompt and tool definitions in token estimate", () => {
      // Small messages that alone wouldn't trigger compaction
      const msgs = [makeUserMessage("short message")];
      // But a huge system prompt pushes it over threshold
      const hugeSystemPrompt = "x".repeat(2_000_000);
      const tools = [
        { name: "bigTool", description: "x".repeat(500_000), parameters: { type: "object" } },
      ];
      expect(shouldCompact(msgs, model, 0.8, hugeSystemPrompt, tools)).toBe(true);
    });

    it("F5: returns false when system prompt + tools are small", () => {
      const msgs = [makeUserMessage("short message")];
      const systemPrompt = "You are a helpful assistant.";
      const tools = [{ name: "readFile", description: "Read a file", parameters: { type: "object" } }];
      expect(shouldCompact(msgs, model, 0.8, systemPrompt, tools)).toBe(false);
    });
  });

  describe("findSplitPoint", () => {
    it("returns messages.length when too few messages", () => {
      const msgs = [makeUserMessage("hi")];
      expect(findSplitPoint(msgs)).toBe(msgs.length);
    });

    it("returns messages.length for 4 or fewer messages", () => {
      const msgs = [
        makeUserMessage("1"),
        makeAssistantMessage([{ type: "text", text: "2" }]),
        makeUserMessage("3"),
        makeAssistantMessage([{ type: "text", text: "4" }]),
      ];
      expect(findSplitPoint(msgs)).toBe(msgs.length);
    });

    it("splits preserving last 20% by default", () => {
      const msgs: Message[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(makeUserMessage(`user message ${i} with some content`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `assistant reply ${i} with some content` }]));
      }
      const split = findSplitPoint(msgs, 0.2);
      // Should split somewhere in the first ~80%
      expect(split).toBeGreaterThan(0);
      expect(split).toBeLessThan(msgs.length);
      // Last 2 messages should be preserved
      expect(msgs.length - split).toBeGreaterThanOrEqual(2);
    });

    it("does not split in the middle of a tool-call sequence", () => {
      const msgs: Message[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(makeUserMessage(`user ${i}`));
        msgs.push(makeAssistantMessage([
          { type: "toolCall", id: `tc_${i}`, name: "readFile", arguments: { path: `/file${i}.ts` } },
        ], "toolUse"));
        msgs.push(makeToolResultMessage(`tc_${i}`, "readFile", `content of file ${i}`));
      }
      const split = findSplitPoint(msgs, 0.2);
      // Split point should not land on a toolResult
      if (split < msgs.length) {
        expect(msgs[split]!.role).not.toBe("toolResult");
      }
    });
  });

  describe("compactSession", () => {
    it("returns original messages when too few to compact", async () => {
      const paths = makePaths();
      const msgs = [
        makeUserMessage("hi"),
        makeAssistantMessage([{ type: "text", text: "hello" }]),
      ];
      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "test-1",
      });
      expect(result.performed).toBe(false);
      expect(result.messages).toBe(msgs);
      expect(result.compactedTurnCount).toBe(0);
    });

    it("compacts old turns and preserves recent ones", async () => {
      const paths = makePaths();
      const summaryText = "## Completed Work\nDid stuff.\n\n## Open Tasks\ndo more";
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(summaryText));

      const msgs: Message[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(makeUserMessage(`user ${i} — a sufficiently long message to ensure splitting works`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `assistant ${i} — a sufficiently long reply to ensure splitting works` }]));
      }

      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "test-2",
        preserveFraction: 0.2,
      });

      expect(result.performed).toBe(true);
      expect(result.compactedTurnCount).toBeGreaterThan(0);
      expect(result.messages.length).toBeLessThan(msgs.length);
      // The summary should contain the LLM output
      const summaryMessage = result.messages[0]!;
      expect(summaryMessage.role).toBe("user");
      expect(JSON.stringify(summaryMessage.content)).toContain("Compacted Context");
      // Alt-context path should be set
      expect(result.altContextPath).toContain("compaction");
      expect(result.altContextPath).toContain("test-2");
    });

    it("writes alt-context file with full conversation history", async () => {
      const paths = makePaths();
      const summaryText = "Summary of the conversation";
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(summaryText));

      const msgs: Message[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(makeUserMessage(`user message ${i} with key fact: SECRET_VALUE_${i}`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `assistant reply ${i}` }]));
      }

      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "test-3",
        preserveFraction: 0.2,
      });

      expect(result.performed).toBe(true);
      // Read the alt-context file
      const altContent = readFileSync(result.altContextPath, "utf8");
      // Should contain the secret facts from the compacted portion
      expect(altContent).toContain("SECRET_VALUE_0");
      // Should contain the header
      expect(altContent).toContain("Alt-Context for Session test-3");
    });

    it("returns original messages when compaction would inflate", async () => {
      const paths = makePaths();
      // Summary is longer than original — should trigger inflation check
      const longSummary = "x".repeat(10_000);
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(longSummary));

      const msgs: Message[] = [];
      for (let i = 0; i < 6; i++) {
        msgs.push(makeUserMessage(`u${i}`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `a${i}` }]));
      }

      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "test-4",
        preserveFraction: 0.2,
      });

      // The summary is so long that compacted > original
      expect(result.performed).toBe(false);
      expect(result.messages).toBe(msgs);
    });

    it("returns original messages when LLM call fails", async () => {
      const paths = makePaths();
      vi.mocked(complete).mockRejectedValueOnce(new Error("LLM unavailable"));

      const msgs: Message[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(makeUserMessage(`user ${i} with enough content to make compaction worthwhile`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `assistant ${i} with enough content` }]));
      }

      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "test-5",
        preserveFraction: 0.2,
      });

      expect(result.performed).toBe(false);
      expect(result.messages).toBe(msgs);
      // Alt-context file should still exist
      expect(result.altContextPath).toContain("test-5");
    });
  });

  describe("regression: long synthetic session", () => {
    it("trigger fires → summary contains key facts → follow-up can find fact in alt-context file", async () => {
      const paths = makePaths();
      const keyFact = "CRITICAL_API_KEY=sk-test-12345";
      const summaryText = `## Completed Work\nSet up the API.\n\n## Key Decisions\nUsed the critical key.\n\n## Critical Context\n${keyFact}`;
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(summaryText));

      // Build a long synthetic session
      const msgs: Message[] = [];
      msgs.push(makeUserMessage("Let's set up the authentication system."));
      msgs.push(makeAssistantMessage([{ type: "text", text: "I'll help you set up authentication." }]));
      msgs.push(makeUserMessage(`First, store this: ${keyFact}`));
      msgs.push(makeAssistantMessage([{ type: "text", text: "Stored the key." }]));
      // Fill with padding turns
      for (let i = 0; i < 20; i++) {
        msgs.push(makeUserMessage(`Turn ${i}: do something with padding content to fill the context`));
        msgs.push(makeAssistantMessage([{ type: "text", text: `Done with turn ${i}, padding the conversation.` }]));
      }

      // 1. Trigger fires (shouldCompact with low threshold)
      // With 24+ messages of decent size, should be compactable
      const result = await compactSession(msgs, {
        model,
        paths,
        sessionId: "regression-1",
        preserveFraction: 0.15,
      });

      // 2. Summary contains key facts
      expect(result.performed).toBe(true);
      const summaryContent = JSON.stringify(result.messages[0]!.content);
      expect(summaryContent).toContain(keyFact);
      expect(summaryContent).toContain("Compacted Context");

      // 3. Alt-context file contains the full original compacted conversation
      const altContent = readFileSync(result.altContextPath, "utf8");
      expect(altContent).toContain(keyFact);
      expect(altContent).toContain("authentication");
      expect(altContent).toContain("Turn 0");
      // The earliest turns are in the alt-context (compacted portion)
      // Turn 19 may be in the preserved portion, but early turns must be in alt-context
    });
  });

  describe("agent loop integration", () => {
    function makeUserMsg(content: string): Message {
      return { role: "user", content, timestamp: Date.now() };
    }

    function makeAssistantMsg(content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>, stopReason: "stop" | "toolUse" = "stop") {
      return {
        role: "assistant" as const,
        content,
        stopReason,
        provider: "minimax" as const,
        api: "anthropic-messages" as const,
        model: "MiniMax-M2.7",
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
    }

    function mockStreamResponse(finalMessage: any): any {
      const events: any[] = [
        { type: "text_delta", contentIndex: 0, delta: finalMessage.content[0]?.text ?? "", partial: makeAssistantMsg([], "stop") },
        { type: "done", reason: finalMessage.stopReason, message: finalMessage },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        },
        async result() {
          return finalMessage;
        },
      };
    }

    beforeEach(() => {
      vi.mocked(complete).mockReset();
      vi.mocked(stream).mockReset();
    });

    afterEach(() => {
      vi.mocked(complete).mockReset();
      vi.mocked(stream).mockReset();
    });

    it("auto-compacts before LLM call when messages exceed threshold", async () => {
      const paths = makePaths();
      const keyFact = "DEPLOY_TOKEN=abc-xyz-123";

      // Mock complete() for compaction — returns a short summary
      const summaryText = `## Completed Work\nSet up deploy.\n\n## Critical Context\n${keyFact}`;
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(summaryText));

      // Mock stream() for the actual agent turn — returns a simple response
      const agentResponse = makeAssistantMsg([{ type: "text", text: "Done." }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStreamResponse(agentResponse));

      // Build a large enough set of messages to trigger compaction.
      // We use a very low threshold (0.01) so compaction triggers with fewer messages.
      const msgs: Message[] = [];
      msgs.push(makeUserMsg(`Store this: ${keyFact}`));
      msgs.push(makeAssistantMsg([{ type: "text", text: "Stored." }]));
      for (let i = 0; i < 20; i++) {
        msgs.push(makeUserMsg(`Turn ${i}: ${"x".repeat(200)}`));
        msgs.push(makeAssistantMsg([{ type: "text", text: `Reply ${i}: ${"y".repeat(200)}` }]));
      }

      const agent = createAgent({
        tools: [],
        model,
      });

      const result = await agent.run(msgs, {
        compaction: {
          paths,
          sessionId: "agent-integration-1",
          threshold: 0.01, // very low so it triggers with our test messages
        },
      });

      // 1. Compaction happened: complete() was called (for the summary)
      expect(complete).toHaveBeenCalledTimes(1);

      // 2. stream() was called — the actual LLM call went through
      expect(stream).toHaveBeenCalledTimes(1);

      // 3. The message array was mutated in place (compacted)
      // The first message should now be the compacted summary, not the original user message
      expect(msgs.length).toBeLessThan(42);
      const firstMsgContent = JSON.stringify(msgs[0]);
      expect(firstMsgContent).toContain("Compacted Context");
      expect(firstMsgContent).toContain(keyFact);

      // 4. Alt-context file was written
      const altContent = readFileSync(join(paths.state, "compaction", "agent-integration-1.md"), "utf8");
      expect(altContent).toContain(keyFact);

      // 5. The agent returned successfully
      expect(result.aborted).toBe(false);
      expect(result.finalMessage).toBe("Done.");
    });

    it("does NOT compact when below threshold", async () => {
      const paths = makePaths();

      const agentResponse = makeAssistantMsg([{ type: "text", text: "Hi." }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStreamResponse(agentResponse));

      const msgs = [makeUserMsg("hello")];

      const agent = createAgent({
        tools: [],
        model,
      });

      await agent.run(msgs, {
        compaction: {
          paths,
          sessionId: "agent-integration-2",
          threshold: 0.8, // default — "hello" is way under
        },
      });

      // complete() should NOT have been called — no compaction
      expect(complete).not.toHaveBeenCalled();
      expect(stream).toHaveBeenCalledTimes(1);

      // Messages unchanged (no compaction), but agent appended its response
      expect(msgs.length).toBe(2); // original user msg + agent response
      expect(msgs[0]!.role).toBe("user");
    });

    // ─── F1 Regression: compaction options are per-run ───

    it("F1: uses compaction sessionId from RunOptions, not from shared agent state", async () => {
      const paths = makePaths();

      // Mock complete() for compaction summary
      const summaryText = "## Summary\nCompacted.";
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse(summaryText));

      // Mock stream() for the agent turn
      const agentResponse = makeAssistantMsg([{ type: "text", text: "ok" }], "stop");
      vi.mocked(stream).mockReturnValueOnce(mockStreamResponse(agentResponse));

      const msgs: Message[] = [];
      msgs.push(makeUserMsg("Store this: KEY=secret-1"));
      msgs.push(makeAssistantMsg([{ type: "text", text: "Stored." }]));
      for (let i = 0; i < 20; i++) {
        msgs.push(makeUserMsg(`Turn ${i}: ${"x".repeat(200)}`));
        msgs.push(makeAssistantMsg([{ type: "text", text: `Reply ${i}: ${"y".repeat(200)}` }]));
      }

      const agent = createAgent({ tools: [], model });

      // Pass compaction via RunOptions with a specific sessionId
      await agent.run(msgs, {
        compaction: {
          paths,
          sessionId: "per-run-session-id",
          threshold: 0.01,
        },
      });

      // Alt-context file should be written with the per-run sessionId
      const altPath = join(paths.state, "compaction", "per-run-session-id.md");
      const altContent = readFileSync(altPath, "utf8");
      expect(altContent).toContain("KEY=secret-1");
    });

    it("F1: two run() calls with different sessionIds write to different alt-context files", async () => {
      // Use a state dir that's test-specific so we don't interfere with real state
      const tmpState = mkdtempSync(join(tmpdir(), "harness-f1-state-"));
      const paths = { ...makePaths(), state: tmpState };

      // First run
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse("Summary A"));
      vi.mocked(stream).mockReturnValueOnce(mockStreamResponse(
        makeAssistantMsg([{ type: "text", text: "ok A" }], "stop"),
      ));

      const msgsA: Message[] = [];
      msgsA.push(makeUserMsg("FACT_A=value-a"));
      msgsA.push(makeAssistantMsg([{ type: "text", text: "ok" }]));
      for (let i = 0; i < 20; i++) {
        msgsA.push(makeUserMsg(`A${i}: ${"x".repeat(200)}`));
        msgsA.push(makeAssistantMsg([{ type: "text", text: `R${i}: ${"y".repeat(200)}` }]));
      }

      const agent = createAgent({ tools: [], model });
      await agent.run(msgsA, {
        compaction: { paths, sessionId: "session-alpha", threshold: 0.01 },
      });

      // Second run — same agent, different sessionId
      vi.mocked(complete).mockResolvedValueOnce(mockCompleteResponse("Summary B"));
      vi.mocked(stream).mockReturnValueOnce(mockStreamResponse(
        makeAssistantMsg([{ type: "text", text: "ok B" }], "stop"),
      ));

      const msgsB: Message[] = [];
      msgsB.push(makeUserMsg("FACT_B=value-b"));
      msgsB.push(makeAssistantMsg([{ type: "text", text: "ok" }]));
      for (let i = 0; i < 20; i++) {
        msgsB.push(makeUserMsg(`B${i}: ${"x".repeat(200)}`));
        msgsB.push(makeAssistantMsg([{ type: "text", text: `R${i}: ${"y".repeat(200)}` }]));
      }

      await agent.run(msgsB, {
        compaction: { paths, sessionId: "session-beta", threshold: 0.01 },
      });

      // Both alt-context files exist with correct content
      const altA = readFileSync(join(paths.state, "compaction", "session-alpha.md"), "utf8");
      const altB = readFileSync(join(paths.state, "compaction", "session-beta.md"), "utf8");
      expect(altA).toContain("FACT_A");
      expect(altB).toContain("FACT_B");
      expect(altA).not.toContain("FACT_B");
      expect(altB).not.toContain("FACT_A");
    });

    // ─── F4 Regression: compaction cooldown after failure ───

    it("F4: does NOT retry compaction every iteration after a failure", async () => {
      const paths = makePaths();

      // Mock stream: first returns toolUse (so loop iterates), then stop.
      const toolCallResponse = makeAssistantMsg(
        [{ type: "toolCall", id: "tc1", name: "noop", arguments: {} }],
        "toolUse",
      );
      const finalResponse = makeAssistantMsg([{ type: "text", text: "done" }], "stop");

      vi.mocked(stream)
        .mockReturnValueOnce(mockStreamResponse(toolCallResponse))
        .mockReturnValueOnce(mockStreamResponse(finalResponse));

      // complete() always fails — simulates LLM unavailability
      vi.mocked(complete).mockRejectedValue(new Error("LLM unavailable"));

      // Build messages large enough to trigger compaction at low threshold
      const msgs: Message[] = [];
      for (let i = 0; i < 20; i++) {
        msgs.push(makeUserMsg(`user ${i} ${"x".repeat(200)}`));
        msgs.push(makeAssistantMsg([{ type: "text", text: `reply ${i} ${"y".repeat(200)}` }]));
      }
      // Add a tool result to satisfy the toolUse response
      msgs.push({
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "noop",
        content: [{ type: "text", text: "noop result" }],
        isError: false,
        timestamp: Date.now(),
      } as Message);

      const noopTool = {
        name: "noop",
        description: "no-op",
        parameters: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
        async execute() { return "ok"; },
      };

      const agent = createAgent({ tools: [noopTool as any], model });

      await agent.run(msgs, {
        compaction: { paths, sessionId: "cooldown-test", threshold: 0.01 },
      });

      // complete() should have been called at most once — the cooldown
      // prevents retry on subsequent iterations
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });
});

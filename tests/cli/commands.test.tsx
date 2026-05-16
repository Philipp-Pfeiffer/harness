import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import App from "../../src/cli/App.js";

vi.mock("../../src/tools/registry.js", () => ({
  loadTools: vi.fn(() => []),
  findTool: vi.fn(() => undefined),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    getModel: vi.fn(() => ({ id: "test-model" })),
  };
});

const mockRun = vi.fn();

vi.mock("../../src/core/agent.js", () => ({
  createAgent: vi.fn(() => ({
    run: mockRun,
    setModel: vi.fn(),
  })),
}));

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  cleanup();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Slash command autocomplete picker", () => {
  it("opens picker when / is typed and shows all commands", async () => {
    const { lastFrame, stdin } = render(<App />);

    stdin.write("/");
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain("/clear");
    expect(frame).toContain("/help");
    expect(frame).toContain("/quit");
  });

  it("filters commands live while typing", async () => {
    const { lastFrame, stdin } = render(<App />);

    stdin.write("/cl");
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain("/clear");
    expect(frame).not.toContain("/help");
    expect(frame).not.toContain("/quit");
  });

  it("closes picker on space and keeps input", async () => {
    const { lastFrame, stdin } = render(<App />);

    stdin.write("/cl");
    await delay(50);

    let frame = lastFrame();
    expect(frame).toContain("/clear");

    stdin.write(" ");
    await delay(50);

    frame = lastFrame();
    expect(frame).not.toContain("/clear  –");
    expect(frame).toContain("/cl");
  });

  it("completes command with Enter without auto-executing", async () => {
    const { lastFrame, stdin, frames } = render(<App />);

    stdin.write("/cl");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    // After first Enter, picker should close and input should show /clear
    let frame = lastFrame();
    expect(frame).toContain("/clear");

    // Should NOT have executed yet (no help card rendered)
    const allFrames = frames.join("\n");
    expect(allFrames).not.toContain("Commands");
  });

  it("closes picker on Escape and leaves input as-is", async () => {
    const { lastFrame, stdin } = render(<App />);

    stdin.write("/cl");
    await delay(50);

    let frame = lastFrame();
    expect(frame).toContain("/clear");

    stdin.write("\x1b"); // Escape
    await delay(50);

    frame = lastFrame();
    expect(frame).not.toContain("/clear  –");
    expect(frame).toContain("/cl");
  });

  it("navigates with up/down arrows", async () => {
    const { lastFrame, stdin } = render(<App />);

    stdin.write("/");
    await delay(50);

    // Default selection is first item (/clear)
    let frame = lastFrame();
    expect(frame).toContain("/clear");

    // Press down three times to reach /quit (clear → help → model → quit)
    stdin.write("\x1b[B");
    await delay(50);
    stdin.write("\x1b[B");
    await delay(50);
    stdin.write("\x1b[B");
    await delay(50);

    // Press Enter to complete /quit
    stdin.write("\r");
    await delay(50);

    frame = lastFrame();
    expect(frame).toContain("/quit");
  });
});

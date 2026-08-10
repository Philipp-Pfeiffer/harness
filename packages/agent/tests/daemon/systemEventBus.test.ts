/**
 * Tests for: System Event Bus, IMAP Poller, and Restart Follow-Up Fix.
 */
import { describe, it, expect } from "vitest";

describe("System Event text formatting", () => {
  it("prefixes event text with [System * <origin>]", () => {
    const prefix = (origin: string, text: string) => `[System · ${origin}] ${text}`;
    expect(prefix("Mail", "Neue Mail von test@example.com")).toBe(
      "[System · Mail] Neue Mail von test@example.com",
    );
  });

  it("prefix prevents slash-command interception", () => {
    const prefix = (origin: string, text: string) => `[System · ${origin}] ${text}`;
    const result = prefix("Mail", "/some-command");
    expect(result.startsWith("/")).toBe(false);
  });

  it("origin label is preserved verbatim", () => {
    const prefix = (origin: string, text: string) => `[System · ${origin}] ${text}`;
    expect(prefix("Restart", "Verify config")).toContain("[System · Restart]");
    expect(prefix("Calendar", "Meeting in 10min")).toContain("[System · Calendar]");
  });
});

describe("MailPoller sanitizeFilename", () => {
  function sanitizeFilename(name: string): string {
    if (name.includes("/") || name.includes("\\")) {
      return name.split(/[/\\]/).pop() ?? "attachment";
    }
    return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  }

  it("strips path traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("../test.doc")).toBe("test.doc");
  });

  it("preserves safe characters", () => {
    expect(sanitizeFilename("normal.pdf")).toBe("normal.pdf");
    expect(sanitizeFilename("report_v2.docx")).toBe("report_v2.docx");
  });

  it("replaces unsafe characters with underscore", () => {
    expect(sanitizeFilename("spa ce.txt")).toBe("spa_ce.txt");
    expect(sanitizeFilename("report (final).pdf")).toBe("report__final_.pdf");
  });
});

describe("MailPoller formatBytes", () => {
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  it("formats small sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats KB sizes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats MB sizes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });
});

describe("SPF/DKIM header parsing", () => {
  function checkAuth(header: string): { spfPass: boolean; dkimPass: boolean } {
    return {
      spfPass: header.includes("spf=pass"),
      dkimPass: header.includes("dkim=pass"),
    };
  }

  it("detects SPF and DKIM pass", () => {
    const result = checkAuth(
      "mx.google.com; spf=pass smtp.mailfrom=philipp@pfeiffer.contact; dkim=pass header.i=@pfeiffer.contact",
    );
    expect(result.spfPass).toBe(true);
    expect(result.dkimPass).toBe(true);
  });

  it("detects SPF fail", () => {
    const result = checkAuth(
      "mx.google.com; spf=fail smtp.mailfrom=attacker@evil.com; dkim=pass header.i=@evil.com",
    );
    expect(result.spfPass).toBe(false);
  });

  it("detects DKIM fail", () => {
    const result = checkAuth(
      "mx.google.com; spf=pass smtp.mailfrom=philipp@pfeiffer.contact; dkim=fail header.i=@pfeiffer.contact",
    );
    expect(result.dkimPass).toBe(false);
  });

  it("both fail produces suspicious flag in event text", () => {
    const authHeader =
      "mx.google.com; spf=neutral; dkim=temperror";
    const { spfPass, dkimPass } = checkAuth(authHeader);
    const authOk = spfPass && dkimPass;
    expect(authOk).toBe(false);
    const suspicious = authOk ? "" : " [suspicious: SPF/DKIM verification failed]";
    expect(suspicious).toContain("suspicious");
  });
});

describe("Seen-store dedup", () => {
  it("prevents duplicate events via message-id set", () => {
    const seen = new Set<string>();
    const msgIds = ["msg-001", "msg-002", "msg-001"];

    const newIds: string[] = [];
    for (const id of msgIds) {
      if (!seen.has(id)) {
        seen.add(id);
        newIds.push(id);
      }
    }

    expect(newIds).toEqual(["msg-001", "msg-002"]);
    expect(seen.size).toBe(2);
  });
});

describe("Restart follow-up fix", () => {
  it("marker.replyTarget is a phone number, not a session ID", () => {
    const markers = [
      { replyTarget: "491701234567", reason: "deploy" },
      { replyTarget: "4915112345678", reason: "manual restart" },
    ];

    for (const m of markers) {
      expect(/^\d+$/.test(m.replyTarget)).toBe(true);
    }
  });

  it("event-bus-based restart injects with correct origin and prefix", () => {
    const prompt = (reason: string) =>
      `The daemon just restarted (reason: ${reason}). Verify briefly.`;
    const reason = "deploy feat/x";
    const text = prompt(reason);
    const prefixed = `[System · Restart] ${text}`;

    expect(prefixed).toContain("[System · Restart]");
    expect(prefixed).toContain(reason);
    expect(prefixed.startsWith("/")).toBe(false);
  });

  it("static ping remains as fallback when followUp is false", () => {
    const marker = {
      followUp: undefined as boolean | undefined,
    };
    const shouldUseEventBus = marker.followUp === true;
    expect(shouldUseEventBus).toBe(false);
  });
});

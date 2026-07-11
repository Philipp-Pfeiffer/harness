import { describe, it, expect } from "vitest";
import { createMailbox } from "../../src/core/mailbox.js";

describe("Mailbox", () => {
  it("push adds a message", () => {
    const mailbox = createMailbox();
    expect(mailbox.isEmpty()).toBe(true);
    mailbox.push("hello");
    expect(mailbox.isEmpty()).toBe(false);
  });

  it("drainAll returns all messages and empties the mailbox", () => {
    const mailbox = createMailbox();
    mailbox.push("first");
    mailbox.push("second");
    const drained = mailbox.drainAll();
    expect(drained).toEqual(["first", "second"]);
    expect(mailbox.isEmpty()).toBe(true);
  });

  it("drainAll on empty mailbox returns empty array", () => {
    const mailbox = createMailbox();
    const drained = mailbox.drainAll();
    expect(drained).toEqual([]);
    expect(mailbox.isEmpty()).toBe(true);
  });

  it("isEmpty returns true after drainAll", () => {
    const mailbox = createMailbox();
    mailbox.push("msg");
    expect(mailbox.isEmpty()).toBe(false);
    mailbox.drainAll();
    expect(mailbox.isEmpty()).toBe(true);
  });

  it("multiple push and drainAll cycles work independently", () => {
    const mailbox = createMailbox();
    mailbox.push("a");
    expect(mailbox.drainAll()).toEqual(["a"]);
    mailbox.push("b");
    mailbox.push("c");
    expect(mailbox.drainAll()).toEqual(["b", "c"]);
    expect(mailbox.isEmpty()).toBe(true);
  });
});

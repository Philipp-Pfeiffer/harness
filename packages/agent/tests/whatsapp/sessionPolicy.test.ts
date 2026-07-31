import { describe, it, expect, vi } from "vitest";
import { PerKeyLock } from "../../src/util/perKeyLock.js";
import {
  isRealtimeInboundUpsert,
  shouldNotifyWhatsAppSessionReset,
} from "../../src/whatsapp/sessionPolicy.js";

describe("PerKeyLock", () => {
  it("deduplicates concurrent work for the same key", async () => {
    const lock = new PerKeyLock();
    let runs = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        lock.run("4915170284381", async () => {
          runs++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "session-1";
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(results).toEqual(Array.from({ length: 20 }, () => "session-1"));
  });

  it("runs separate work for different keys", async () => {
    const lock = new PerKeyLock();
    const fn = vi.fn(async (value: string) => value);

    const [a, b] = await Promise.all([
      lock.run("a", () => fn("one")),
      lock.run("b", () => fn("two")),
    ]);

    expect(a).toBe("one");
    expect(b).toBe("two");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("shouldNotifyWhatsAppSessionReset", () => {
  it("notifies only when replacing an inactive session", () => {
    expect(shouldNotifyWhatsAppSessionReset(true)).toBe(true);
    expect(shouldNotifyWhatsAppSessionReset(false)).toBe(false);
  });
});

describe("isRealtimeInboundUpsert", () => {
  it("accepts notify and rejects append history sync", () => {
    expect(isRealtimeInboundUpsert("notify")).toBe(true);
    expect(isRealtimeInboundUpsert("append")).toBe(false);
  });
});

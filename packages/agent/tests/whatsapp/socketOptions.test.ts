/**
 * Socket Options Tests.
 *
 * Verifies that createWhatsAppClient passes syncFullHistory:false
 * and markOnlineOnConnect:true to makeWASocket.
 *
 * markOnlineOnConnect:true lets Baileys report "available" itself on
 * connect; with false it would send "unavailable" and hide the online
 * status. syncFullHistory:false prevents pulling the full chat history.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// hoisted references for vi.mock factory (vitest hoists vi.mock calls)
const { makeWASocketSpy, useMultiFileAuthStateSpy, fetchLatestBaileysVersionSpy } = vi.hoisted(() => ({
  makeWASocketSpy: vi.fn(),
  useMultiFileAuthStateSpy: vi.fn(),
  fetchLatestBaileysVersionSpy: vi.fn(),
}));

vi.mock("baileys", () => ({
  makeWASocket: makeWASocketSpy,
  useMultiFileAuthState: useMultiFileAuthStateSpy,
  fetchLatestBaileysVersion: fetchLatestBaileysVersionSpy,
  DisconnectReason: { loggedOut: 401 },
}));

vi.mock("pino", () => ({
  default: () => ({
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createWhatsAppClient } from "../../src/whatsapp/client.js";

function fakeEv() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on(name: string, fn: (...args: unknown[]) => void) {
      handlers[name] = fn;
    },
    off: vi.fn(),
    emit(name: string, ...args: unknown[]) {
      handlers[name]?.(...args);
    },
  };
}

function fakeSock() {
  return {
    ev: fakeEv(),
    end: vi.fn(),
    sendMessage: vi.fn(),
    logout: vi.fn(),
    readMessages: vi.fn(),
    sendPresenceUpdate: vi.fn(),
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("createWhatsAppClient socket options", () => {
  it("passes syncFullHistory:false and markOnlineOnConnect:true to makeWASocket", async () => {
    const sock = fakeSock();
    makeWASocketSpy.mockReturnValue(sock);
    useMultiFileAuthStateSpy.mockResolvedValue({
      state: { creds: { registered: true }, keys: { get: vi.fn(), set: vi.fn() } },
      saveCreds: vi.fn(),
    });
    fetchLatestBaileysVersionSpy.mockResolvedValue({ version: [2, 3000, 100] });

    const client = createWhatsAppClient({
      authDir: "/tmp/test-auth",
      phoneNumber: "1234567890",
      log: () => {},
      onMessage: () => {},
      onConnectionUpdate: () => {},
    });

    await client.start();

    expect(makeWASocketSpy).toHaveBeenCalledTimes(1);
    const config = makeWASocketSpy.mock.calls[0]![0]!;
    expect(config).toMatchObject({
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
  });

  it("passes syncFullHistory:false and markOnlineOnConnect:true when creds not registered", async () => {
    const sock = fakeSock();
    makeWASocketSpy.mockReturnValue(sock);
    useMultiFileAuthStateSpy.mockResolvedValue({
      state: { creds: { registered: false }, keys: { get: vi.fn(), set: vi.fn() } },
      saveCreds: vi.fn(),
    });
    fetchLatestBaileysVersionSpy.mockResolvedValue({ version: [2, 3000, 100] });

    const client = createWhatsAppClient({
      authDir: "/tmp/test-auth",
      phoneNumber: "1234567890",
      log: () => {},
      onMessage: () => {},
      onConnectionUpdate: () => {},
    });

    await client.start();

    const config = makeWASocketSpy.mock.calls[0]![0]!;
    expect(config).toMatchObject({
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
  });
});

describe("createWhatsAppClient presence updates", () => {
  function setupClient() {
    const sock = fakeSock();
    makeWASocketSpy.mockReturnValue(sock);
    useMultiFileAuthStateSpy.mockResolvedValue({
      state: { creds: { registered: true }, keys: { get: vi.fn(), set: vi.fn() } },
      saveCreds: vi.fn(),
    });
    fetchLatestBaileysVersionSpy.mockResolvedValue({ version: [2, 3000, 100] });

    const client = createWhatsAppClient({
      authDir: "/tmp/test-auth",
      phoneNumber: "1234567890",
      log: () => {},
      onMessage: () => {},
      onConnectionUpdate: () => {},
    });

    return { sock, client };
  }

  it("sendPresenceUpdate forwards type and jid to the Baileys socket", async () => {
    const { sock, client } = setupClient();
    await client.start();

    await client.sendPresenceUpdate("composing", "491701234567");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("composing", "491701234567");

    await client.sendPresenceUpdate("available");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available", undefined);
  });
});

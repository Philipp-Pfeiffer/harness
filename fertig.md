# Voice v1.1 — fertig

- Status: implementiert + getestet (Core 587 passed, Agent 641 passed, Adapter 30 passed)
- Commits:
  - Harness: `b105153` (`feat/voice-outbound`)
  - Adapter: `101008f` (`feat/outbound`)
- Adapter: BEREITS DEPLOYED (`harness-voice.service` restarted, `active`) — KEIN weiterer Adapter-Restart nötig
- Harness: bereit für `/deploy feat/voice-outbound`
- Registry: `~/harness/voice-registry.json` angelegt (Philipp `4915110619636`)
- Bekannte prä-existente rote Tests (ignorieren):
  - `exec.test.ts` "elevated > id -u" (sudo) — der einzige tatsächlich rote Test in diesem Lauf.
  - `browser/obscura` `stopObscuraProcess` (Timeout) und `output/pipeline` whatsapp
    snapshot (Trailing-Newline) — in diesem Lauf grün, nur als bekannte Flakes gelistet.
- Offene Punkte: keine

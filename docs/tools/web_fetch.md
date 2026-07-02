# Tool: web_fetch

**Status:** Implementiert (Phase 1)
**Datei:** `src/tools/web_fetch.ts`
**Security:** `src/tools/webSecurity.ts`

## Überblick

Ruft eine öffentliche Webseite ab, extrahiert lesbaren Text/Markdown und liefert einen gekappten Ausschnitt zurück. Niemals die ganze Seite ins Transcript.

## Parameter

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `url` | `string` | Ja | Nur `http://` oder `https://`. |
| `line_start` | `integer` | Nein | 1-indexierte Zeile, ab der fortgesetzt wird. |

## Output

```xml
<web_content url="https://example.com/article" untrusted="true">
--- Lines 1-42 of 512 ---
<gekürzter Markdown-Text>
[...truncated; use line_start=43 to continue]
</web_content>
```

## Limits

- **Output-Cap:** ca. 6.000 Zeichen (konfigurierbar über `web_fetch.outputCap`).
- **Timeout:** 15s default (`web_fetch.timeout`).
- **Max-Response-Size:** 2 MB default (`web_fetch.maxResponseSize`).
- **Redirect-Limit:** 5 (`web_fetch.redirectLimit`).

## SSRF-Härtung

- **Blockierte Schemes:** `file://`, `ftp://`, etc.
- **Blockierte Hosts:** `localhost`, `*.localhost`.
- **Blockierte IPs:** `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`.
- **DNS-Rebinding:** Hostname wird vor dem Request aufgelöst; resolved IPs werden geprüft. Bei jedem Redirect-Hop erneut.
- **Allowlist:** `web_fetch.allowlist` erlaubt explizit Hosts, die sonst private IPs auflösen (Test-/Intranet-Setups).

## Fehlerfälle

| Input | Output |
|-------|--------|
| Private URL | `web_fetch failed: Private IP address is blocked: ...` |
| Ungültiges Scheme | `web_fetch failed: Unsupported URL scheme: ...` |
| Timeout | `web_fetch failed: Request timed out after ...` |
| Zu viele Redirects | `web_fetch failed: Too many redirects ...` |
| Response zu groß | `web_fetch failed: Response exceeds maximum size ...` |
| `line_start` zu groß | `Error: line_start out of range ...` |

## Config-Beispiel

```json
{
  "web_fetch": {
    "outputCap": 6000,
    "timeout": 15000,
    "maxResponseSize": 2097152,
    "redirectLimit": 5,
    "allowlist": ["intranet.example.com"]
  }
}
```

## Nicht enthalten (Phase 2)

- Browser-Rendering / JavaScript-Ausführung.
- Cookie-Sessions.
- Authentifizierte Requests.

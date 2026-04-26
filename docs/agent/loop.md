# Agent Loop

## Tool-Call Logging

Tool-Ergebnisse werden geloggt, aber für lange Outputs gekürzt:

```
[TOOL CALL] readFile({"path":"doc.pdf"}) → --- PDF, 3 pages ---
Hello World! Lorem ipsum dolor sit amet...
...
```

- **Logger-Truncation:** Erstes 200-Zeichen + `...`
- **Voller Result:** Geht trotzdem an das Model (für Reasoning)

Das ist relevant für `readFile` bei großen PDFs — das Model bekommt den vollen Text, nur die CLI-Ausgabe ist truncated.

## Tool-Result Flow

```
Agent.run(input)
  → complete(model, context) [pi-ai]
  → response.stopReason === "toolUse"
  → tool.execute(args)
  → logger (truncated)
  → createToolResultMessage(..., result, isError)
  → context.messages.push(resultMessage)
  → continue
```
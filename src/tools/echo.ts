import { Type } from "@mariozechner/pi-ai";
import type { Tool } from "../tools/types.js";

const echoParameters = Type.Object({
  text: Type.String({ description: "Der Text, der zurückgegeben werden soll" }),
});

export const echoTool: Tool<typeof echoParameters> = {
  name: "echo",
  description: "Gibt den übergebenen Text zurück. Nützlich um zu testen, ob Tool-Calling funktioniert.",
  parameters: echoParameters,
  execute(args) {
    return args.text;
  },
};

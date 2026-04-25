import type { Static, TSchema } from "@mariozechner/pi-ai";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  execute(args: Static<TParameters>): Promise<string> | string;
}

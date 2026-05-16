import type { Static, TSchema } from "@mariozechner/pi-ai";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  execute(args: Static<TParameters>): Promise<string> | string;
  /**
   * Optional: returns a string key that determines which tool calls
   * must run serially with respect to each other. Tool calls with the
   * same conflictKey execute sequentially in original order. Returns
   * `null` or `undefined` → no conflict, runs in parallel with all.
   */
  conflictKey?(args: Static<TParameters>): string | null | undefined;
}

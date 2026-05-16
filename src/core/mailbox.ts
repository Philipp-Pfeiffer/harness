export interface Mailbox {
  push(message: string): void;
  drainAll(): string[];
  isEmpty(): boolean;
}

export function createMailbox(): Mailbox {
  const messages: string[] = [];

  return {
    push(message: string): void {
      messages.push(message);
    },
    drainAll(): string[] {
      const drained = messages.slice();
      messages.length = 0;
      return drained;
    },
    isEmpty(): boolean {
      return messages.length === 0;
    },
  };
}

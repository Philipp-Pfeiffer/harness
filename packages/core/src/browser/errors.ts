export class BrowserSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export class BrowserConnectionError extends BrowserSessionError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserConnectionError";
  }
}

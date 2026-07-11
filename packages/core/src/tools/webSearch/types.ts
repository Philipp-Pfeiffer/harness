export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  k: number;
}

export interface SearchProvider {
  name: string;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

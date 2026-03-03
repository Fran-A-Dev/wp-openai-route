export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id?: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type SearchArgs = {
  query: string;
  filter?: string;
  limit?: number;
  offset?: number;
};

export type FetchArgs = {
  id: string;
};

export type SearchResultItem = {
  id?: string;
  title?: string;
  url?: string;
  snippet?: string;
  [key: string]: unknown;
};

function parseJsonRpcResponse(payload: unknown): JsonRpcSuccess {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON-RPC response payload.");
  }

  const maybeError = payload as JsonRpcError;
  if (maybeError.error) {
    throw new Error(
      `MCP error ${maybeError.error.code}: ${maybeError.error.message}`,
    );
  }

  return payload as JsonRpcSuccess;
}

function extractResultsFromMcpResult(result: unknown): SearchResultItem[] {
  const asItems = (value: unknown): SearchResultItem[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const objectItems = value.filter(
      (item) => item && typeof item === "object",
    ) as SearchResultItem[];

    return objectItems.length > 0 ? objectItems : undefined;
  };

  const parseMaybeJsonString = (value: unknown): unknown => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return value;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };

  const tryExtractFromObject = (obj: Record<string, unknown>): SearchResultItem[] => {
    const directCandidates = [
      obj.results,
      obj.items,
      obj.hits,
      obj.documents,
      obj.data,
      obj.rows,
    ];

    for (const candidate of directCandidates) {
      const asList = asItems(candidate);
      if (asList) {
        return asList;
      }
    }

    return [];
  };

  if (!result) {
    return [];
  }

  const parsedTop = parseMaybeJsonString(result);
  if (!parsedTop || typeof parsedTop !== "object") {
    return [];
  }

  if (Array.isArray(parsedTop)) {
    return asItems(parsedTop) ?? [];
  }

  const topLevel = parsedTop as Record<string, unknown>;
  const topLevelResults = tryExtractFromObject(topLevel);
  if (topLevelResults.length > 0) {
    return topLevelResults;
  }

  const typed = topLevel as {
    content?: Array<{ json?: unknown; text?: unknown }>;
  };
  const content = Array.isArray(typed.content) ? typed.content : [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const jsonCandidate = parseMaybeJsonString(item.json);
    if (jsonCandidate && typeof jsonCandidate === "object") {
      const fromJson = tryExtractFromObject(
        jsonCandidate as Record<string, unknown>,
      );
      if (fromJson.length > 0) {
        return fromJson;
      }
    }

    const textCandidate = parseMaybeJsonString(item.text);
    if (textCandidate && typeof textCandidate === "object") {
      const fromText = tryExtractFromObject(
        textCandidate as Record<string, unknown>,
      );
      if (fromText.length > 0) {
        return fromText;
      }
    }
  }

  return [];
}

export class SmartSearchMcpClient {
  private readonly url: string;
  private readonly token?: string;
  private sessionId?: string;

  constructor(url: string, token?: string) {
    this.url = url;
    this.token = token;
  }

  private buildHeaders(): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    return headers;
  }

  private captureSessionId(response: Response): void {
    const headerSession =
      response.headers.get("mcp-session-id") ??
      response.headers.get("x-mcp-session-id") ??
      response.headers.get("session-id");

    if (headerSession && headerSession.trim()) {
      this.sessionId = headerSession.trim();
    }
  }

  private async rpcCall(method: string, params?: unknown): Promise<unknown> {
    const reqBody = {
      jsonrpc: "2.0",
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      method,
      params,
    };

    const response = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(reqBody),
    });

    this.captureSessionId(response);

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `MCP HTTP ${response.status}: ${response.statusText} - ${bodyText}`,
      );
    }

    const payload = await response.json();
    const parsed = parseJsonRpcResponse(payload);
    return parsed.result;
  }

  private async initializeSession(): Promise<void> {
    const result = await this.rpcCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "wp-admin-copilot",
        version: "1.0.0",
      },
    });

    if (!this.sessionId) {
      const maybeSessionId =
        (result as { sessionId?: string } | undefined)?.sessionId ??
        (result as { session_id?: string } | undefined)?.session_id;
      if (typeof maybeSessionId === "string" && maybeSessionId.trim()) {
        this.sessionId = maybeSessionId.trim();
      }
    }

    // Best-effort MCP initialized notification; some servers require this.
    try {
      await this.rpcCall("notifications/initialized", {});
    } catch {
      // Ignore; not all servers require or support this notification over JSON-RPC requests.
    }
  }

  async callTool<TArgs extends Record<string, unknown>>(
    name: "search" | "fetch",
    args: TArgs,
  ): Promise<unknown> {
    try {
      return await this.rpcCall("tools/call", {
        name,
        arguments: args,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      const needsSessionRecovery =
        /Invalid session ID|Missing session|session id/i.test(msg);

      if (!needsSessionRecovery) {
        throw error;
      }

      // Reset stale session and attempt handshake + one retry.
      this.sessionId = undefined;
      await this.initializeSession();

      return this.rpcCall("tools/call", {
        name,
        arguments: args,
      });
    }
  }

  async search(args: SearchArgs): Promise<{
    raw: unknown;
    results: SearchResultItem[];
  }> {
    const raw = await this.callTool("search", args as Record<string, unknown>);
    const results = extractResultsFromMcpResult(raw);

    return { raw, results };
  }

  async fetch(args: FetchArgs): Promise<unknown> {
    return this.callTool("fetch", args as Record<string, unknown>);
  }
}

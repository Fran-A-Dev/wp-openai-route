import {
  type FetchArgs,
  type SearchArgs,
  type SearchResultItem,
  SmartSearchMcpClient,
} from "@/lib/mcp";

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export const OPENAI_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "smart_search_search",
      description:
        "Searches indexed WordPress content via Smart Search MCP. Use this for list/find/search requests.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          filter: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "smart_search_fetch",
      description:
        "Fetches full indexed document content by Smart Search result id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

export type ToolExecutionContext = {
  mcpClient: SmartSearchMcpClient;
  lastSearchState: {
    query?: string;
    filter?: string;
    limit?: number;
    offset?: number;
    results?: SearchResultItem[];
  };
};

function normalizeSearchArgs(raw: unknown): SearchArgs {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid arguments for smart_search_search.");
  }

  const input = raw as Record<string, unknown>;
  const query = input.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("smart_search_search requires a non-empty query string.");
  }

  const out: SearchArgs = { query: query.trim() };

  if (typeof input.filter === "string" && input.filter.trim()) {
    out.filter = input.filter.trim();
  }

  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    out.limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  }

  if (typeof input.offset === "number" && Number.isFinite(input.offset)) {
    out.offset = Math.max(0, Math.floor(input.offset));
  }

  return out;
}

function normalizeFetchArgs(raw: unknown): FetchArgs {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid arguments for smart_search_fetch.");
  }

  const input = raw as Record<string, unknown>;
  const id = input.id;

  if (typeof id !== "string" || !id.trim()) {
    throw new Error("smart_search_fetch requires a non-empty id string.");
  }

  return { id: id.trim() };
}

export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  if (toolName === "smart_search_search") {
    const args = normalizeSearchArgs(rawArgs);
    const data = await ctx.mcpClient.search(args);

    ctx.lastSearchState.query = args.query;
    ctx.lastSearchState.filter = args.filter;
    ctx.lastSearchState.limit = args.limit ?? 10;
    ctx.lastSearchState.offset = args.offset ?? 0;
    ctx.lastSearchState.results = data.results;

    return {
      tool: "smart_search_search",
      args,
      results: data.results,
      raw: data.raw,
    };
  }

  if (toolName === "smart_search_fetch") {
    const args = normalizeFetchArgs(rawArgs);
    const data = await ctx.mcpClient.fetch(args);

    return {
      tool: "smart_search_fetch",
      args,
      result: data,
    };
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

import { OPENAI_TOOLS, executeTool } from "@/lib/tools";
import { SmartSearchMcpClient, type SearchResultItem } from "@/lib/mcp";

export const runtime = "nodejs";

type ClientMessage = {
  role: "user" | "assistant";
  content: string;
};

type RequestBody = {
  message: string;
  history?: ClientMessage[];
  state?: {
    lastSearch?: {
      query?: string;
      filter?: string;
      limit?: number;
      offset?: number;
      results?: SearchResultItem[];
    };
  };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_LIMIT = 10;

function getCorsHeaders(origin: string | null): HeadersInit {
  const allowOrigin = process.env.WP_ADMIN_ORIGIN ?? "";
  const safeOrigin = origin && origin === allowOrigin ? origin : allowOrigin;

  return {
    "Access-Control-Allow-Origin": safeOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-wp-admin-copilot-token",
    Vary: "Origin",
  };
}

function isNonIndexedAdminQuery(input: string): boolean {
  return /\b(users?|roles?|plugins?|settings?|capabilities|permissions?)\b/i.test(
    input,
  );
}

function shouldHandleMoreQuery(input: string): boolean {
  return /\b(more|next page|next results|more results|show more)\b/i.test(input);
}

function isSearchIntent(input: string): boolean {
  if (shouldHandleMoreQuery(input)) {
    return false;
  }
  return /\b(list|find|search|show)\b/i.test(input);
}

function shouldHandleSummarizeNth(
  input: string,
): { index: number } | undefined {
  const lower = input.toLowerCase();
  const wordMap: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };

  const wordMatch = lower.match(
    /\b(summarize|summary of)\s+(the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+result\b/,
  );
  if (wordMatch) {
    return { index: wordMap[wordMatch[3]] - 1 };
  }

  const numericMatch = lower.match(
    /\b(summarize|summary of)\s+(the\s+)?(\d+)(st|nd|rd|th)?\s+result\b/,
  );
  if (!numericMatch) {
    return undefined;
  }

  const parsed = Number.parseInt(numericMatch[3], 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return { index: parsed - 1 };
}

function inferFilterFromMessage(input: string): string | undefined {
  const lower = input.toLowerCase();
  const parts: string[] = [];

  if (!/\ball content types?\b/.test(lower)) {
    if (/\bpages?\b/.test(lower)) {
      parts.push("post_type:page");
    } else if (/\bposts?\b/.test(lower)) {
      parts.push("post_type:post");
    }
  }

  if (/\bpublished\b/.test(lower)) {
    parts.push("status:published");
  } else if (/\bdraft(s)?\b/.test(lower)) {
    parts.push("status:draft");
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(" AND ");
}

function inferQueryFromMessage(input: string): string {
  const forMatch = input.match(/\bfor\s+(.+)$/i);
  if (forMatch?.[1]) {
    return forMatch[1].replace(/[.?!]+$/, "").trim();
  }

  let cleaned = input
    .replace(
      /\b(can|could|would|please|give|me|you|a|an|the|in|this|wp|admin)\b/gi,
      "",
    )
    .replace(/\b(list|find|search|show)\b/gi, "")
    .replace(/\b(posts?|pages?)\b/gi, "")
    .replace(/\b(published|drafts?)\b/gi, "")
    .replace(/\b(return links?|only|all indexed content)\b/gi, "")
    .replace(/\b(and|with)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/, "");

  cleaned = cleaned
    .replace(/^(related to|about|regarding)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned) {
    return cleaned;
  }

  const lower = input.toLowerCase();
  if (/\bposts?\b/.test(lower)) {
    return "post";
  }
  if (/\bpages?\b/.test(lower)) {
    return "page";
  }
  return "content";
}

function isBroadListingRequest(input: string): boolean {
  const lower = input.toLowerCase();
  const hasListingVerb = /\b(list|show|give me|all)\b/.test(lower);
  const hasCollectionNoun = /\b(posts?|pages?|content)\b/.test(lower);
  if (!hasListingVerb || !hasCollectionNoun) {
    return false;
  }

  // If the inferred query has a specific topic, keep topical search behavior.
  const inferred = inferQueryFromMessage(input).toLowerCase();
  const genericQueries = new Set(["post", "page", "content", "published", "draft"]);
  return genericQueries.has(inferred);
}

function isGenericQuery(query: string): boolean {
  return new Set(["post", "page", "content", "published", "draft"]).has(
    query.toLowerCase().trim(),
  );
}

function shouldApplyStrictTopicalFilter(userMessage: string): boolean {
  return !/\bsearch all indexed content for\b/i.test(userMessage);
}

function buildTopicalTerms(query: string): string[] {
  const stopwords = new Set([
    "you",
    "related",
    "about",
    "regarding",
    "with",
    "from",
    "this",
    "that",
    "the",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "all",
    "indexed",
    "content",
    "search",
  ]);

  const rawWords = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);

  const words = rawWords.filter((t) => !stopwords.has(t));

  const unique = Array.from(new Set(words));

  // Add acronym from the full phrase (including stopwords), e.g. "return of the jedi" -> "rotj".
  const acronym = rawWords.map((w) => w[0]).join("");
  if (acronym.length >= 3) {
    unique.push(acronym);
  }

  return Array.from(new Set(unique));
}

function filterSemanticResults(
  results: SearchResultItem[],
  query: string,
): SearchResultItem[] {
  const terms = buildTopicalTerms(query);
  if (terms.length === 0) {
    return results;
  }

  const matchers = terms.map(
    (term) => new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, "i"),
  );

  const filtered = results.filter((item) => {
    const haystack = [
      typeof item.title === "string" ? item.title : "",
      typeof item.snippet === "string" ? item.snippet : "",
      typeof item.url === "string" ? item.url : "",
    ]
      .join(" ")
      .toLowerCase();

    return matchers.some((matcher) => matcher.test(haystack));
  });

  return filtered;
}

function filterTopicalResults(
  results: SearchResultItem[],
  query: string,
): SearchResultItem[] {
  const normalized = query.toLowerCase().trim();
  if (!normalized || isGenericQuery(normalized)) {
    return results;
  }

  const terms = buildTopicalTerms(normalized);

  if (terms.length === 0) {
    return results;
  }

  const termMatchers = terms.map(
    (term) => new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, "i"),
  );

  const filtered = results.filter((item) => {
    const haystack = [
      typeof item.title === "string" ? item.title : "",
      typeof item.snippet === "string" ? item.snippet : "",
      typeof item.url === "string" ? item.url : "",
    ]
      .join(" ")
      .toLowerCase();

    return termMatchers.some((matcher) => matcher.test(haystack));
  });

  return filtered;
}

function listingQueryFromMessage(input: string): string {
  const lower = input.toLowerCase();
  if (/\bpublished\b/.test(lower)) {
    return "published";
  }
  if (/\bdraft(s)?\b/.test(lower)) {
    return "draft";
  }
  if (/\bposts?\b/.test(lower)) {
    return "post";
  }
  if (/\bpages?\b/.test(lower)) {
    return "page";
  }
  return "content";
}

async function runBroadListingSearch(
  userMessage: string,
  mcpClient: SmartSearchMcpClient,
  lastSearchState: {
    query?: string;
    filter?: string;
    limit?: number;
    offset?: number;
    results?: SearchResultItem[];
  },
): Promise<{
  results: SearchResultItem[];
  attempts: Array<{ query: string; filter?: string; count: number; offset: number }>;
}> {
  const query = listingQueryFromMessage(userMessage);
  const filter = inferFilterFromMessage(userMessage);
  const limit = DEFAULT_LIMIT;
  const maxPages = 3;
  const attempts: Array<{ query: string; filter?: string; count: number; offset: number }> = [];
  const seen = new Set<string>();
  const merged: SearchResultItem[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const result = (await executeTool(
      "smart_search_search",
      {
        query,
        filter,
        limit,
        offset,
      },
      { mcpClient, lastSearchState },
    )) as { results?: SearchResultItem[] };

    const pageResults = result.results ?? [];
    attempts.push({
      query,
      filter,
      count: pageResults.length,
      offset,
    });

    for (const row of pageResults) {
      const uniqueKey =
        (typeof row.id === "string" && row.id) ||
        (typeof row.url === "string" && row.url) ||
        (typeof row.title === "string" && row.title) ||
        JSON.stringify(row);

      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        merged.push(row);
      }
    }

    if (pageResults.length < limit) {
      break;
    }
  }

  if (merged.length > 0) {
    lastSearchState.query = query;
    lastSearchState.filter = filter;
    lastSearchState.limit = limit;
    lastSearchState.results = merged;
  }

  return { results: merged, attempts };
}

async function runSearchWithFallback(
  userMessage: string,
  mcpClient: SmartSearchMcpClient,
  lastSearchState: {
    query?: string;
    filter?: string;
    limit?: number;
    offset?: number;
    results?: SearchResultItem[];
  },
): Promise<{
  results: SearchResultItem[];
  attempts: Array<{ query: string; filter?: string; count: number }>;
}> {
  const inferredFilter = inferFilterFromMessage(userMessage);
  const inferredQuery = inferQueryFromMessage(userMessage);
  const limit = DEFAULT_LIMIT;
  const attempts: Array<{ query: string; filter?: string; count: number }> = [];

  const first = (await executeTool(
    "smart_search_search",
    {
      query: inferredQuery,
      filter: inferredFilter,
      limit,
      offset: 0,
    },
    { mcpClient, lastSearchState },
  )) as { results?: SearchResultItem[] };
  attempts.push({
    query: inferredQuery,
    filter: inferredFilter,
    count: (first.results ?? []).length,
  });

  if ((first.results ?? []).length > 0) {
    return { results: first.results ?? [], attempts };
  }

  // Retry without filter when index filtering differs from assumptions.
  if (inferredFilter) {
    const second = (await executeTool(
      "smart_search_search",
      {
        query: inferredQuery,
        limit,
        offset: 0,
      },
      { mcpClient, lastSearchState },
    )) as { results?: SearchResultItem[] };
    attempts.push({
      query: inferredQuery,
      count: (second.results ?? []).length,
    });

    if ((second.results ?? []).length > 0) {
      return { results: second.results ?? [], attempts };
    }
  }

  // Final retry with the full user message as the query.
  const third = (await executeTool(
    "smart_search_search",
    {
      query: userMessage,
      limit,
      offset: 0,
    },
    { mcpClient, lastSearchState },
  )) as { results?: SearchResultItem[] };
  attempts.push({
    query: userMessage,
    count: (third.results ?? []).length,
  });

  return { results: third.results ?? [], attempts };
}

async function openAiChatCompletion(
  messages: OpenAIMessage[],
  model: string,
  tools = OPENAI_TOOLS,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      tool_choice: "auto",
      tools,
      messages,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `OpenAI HTTP ${response.status}: ${response.statusText} - ${bodyText}`,
    );
  }

  return response.json();
}

function chunkText(input: string): string[] {
  const tokens = input.split(/(\s+)/).filter((part) => part.length > 0);
  const chunks: string[] = [];
  let buffer = "";

  for (const token of tokens) {
    if ((buffer + token).length > 60 && buffer) {
      chunks.push(buffer);
      buffer = token;
    } else {
      buffer += token;
    }
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}

function validateRequestOrigin(req: Request): boolean {
  const allowed = process.env.WP_ADMIN_ORIGIN;
  if (!allowed) {
    return false;
  }

  const requestOrigin = req.headers.get("origin");
  return requestOrigin === allowed;
}

function validateCopilotToken(req: Request): boolean {
  const expectedToken = process.env.WP_ADMIN_COPILOT_TOKEN;
  if (!expectedToken) {
    return false;
  }

  const headerToken = req.headers.get("x-wp-admin-copilot-token");
  if (!headerToken) {
    return false;
  }

  return headerToken.trim() === expectedToken.trim();
}

function buildAuthDebug(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }

  const expected = process.env.WP_ADMIN_COPILOT_TOKEN ?? "";
  const received = req.headers.get("x-wp-admin-copilot-token") ?? "";
  return {
    headerPresent: Boolean(received),
    expectedLength: expected.trim().length,
    receivedLength: received.trim().length,
    sameAfterTrim: received.trim() === expected.trim(),
  };
}

function mcpClientFromEnv() {
  const mcpUrl = process.env.SMART_SEARCH_MCP_URL;
  if (!mcpUrl) {
    throw new Error("SMART_SEARCH_MCP_URL is not configured.");
  }

  return new SmartSearchMcpClient(mcpUrl, process.env.SMART_SEARCH_MCP_TOKEN);
}

function normalizeHistory(history: unknown): ClientMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry): entry is ClientMessage => {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const typed = entry as Record<string, unknown>;
      return (
        (typed.role === "user" || typed.role === "assistant") &&
        typeof typed.content === "string"
      );
    })
    .slice(-20);
}

function buildSystemPrompt(): string {
  return [
    "You are WP Admin Copilot for retrieval only.",
    "You can only use Smart Search MCP tools smart_search_search and smart_search_fetch.",
    "Never claim to access users, roles, plugins, settings, or any non-indexed admin data.",
    "If asked for non-indexed admin data, clearly explain this limitation.",
    "For list/find/search requests, you must call smart_search_search first.",
    "For post type filters: posts -> post_type:post, pages -> post_type:page.",
    "If user asks all content types, do not force post_type filter.",
    "If user asks for more results, continue search by increasing offset by limit.",
    "If user asks to summarize a specific result, call smart_search_fetch with that result id.",
    "Never fabricate titles or URLs. Use only tool output values.",
  ].join(" ");
}

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (!validateRequestOrigin(req)) {
    return new Response(
      JSON.stringify({ error: "Forbidden origin." }),
      {
        status: 403,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  if (!validateCopilotToken(req)) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized token.",
        debug: buildAuthDebug(req),
      }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  const userMessage = typeof body.message === "string" ? body.message.trim() : "";
  if (!userMessage) {
    return new Response(JSON.stringify({ error: "Message is required." }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  const history = normalizeHistory(body.history);
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  const lastSearchState: {
    query?: string;
    filter?: string;
    limit?: number;
    offset?: number;
    results?: SearchResultItem[];
  } = {
    ...(body.state?.lastSearch ?? {}),
  };

  const stream = new ReadableStream({
    start: async (controller) => {
      const encoder = new TextEncoder();
      const send = (event: string, payload: unknown) => {
        const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        send("status", { stage: "validating" });

        if (isNonIndexedAdminQuery(userMessage)) {
          const limitationMessage =
            "This copilot only retrieves indexed content via Smart Search MCP (search/fetch). It cannot list or manage WP Admin users, roles, plugins, or settings.";
          send("delta", { text: limitationMessage });
          send("done", {
            ok: true,
            state: { lastSearch: lastSearchState },
          });
          controller.close();
          return;
        }

        const mcpClient = mcpClientFromEnv();
        send("status", { stage: "thinking" });

        // Deterministic search path to guarantee Smart Search tool usage for search intents.
        if (isSearchIntent(userMessage)) {
          send("delta", { text: "Here are the matching indexed results:\n\n" });
          const broadMode = isBroadListingRequest(userMessage);
          const searchData = broadMode
            ? await runBroadListingSearch(userMessage, mcpClient, lastSearchState)
            : await runSearchWithFallback(userMessage, mcpClient, lastSearchState);
          const inferredQuery = inferQueryFromMessage(userMessage);
          const shouldStrictFilter = shouldApplyStrictTopicalFilter(userMessage);
          const results =
            broadMode
              ? searchData.results
              : shouldStrictFilter
                ? filterTopicalResults(searchData.results, inferredQuery)
                : filterSemanticResults(searchData.results, inferredQuery);
          const { attempts } = searchData;

          if (results.length === 0) {
            send("delta", { text: "No indexed results found." });
            if (process.env.NODE_ENV !== "production") {
              send("delta", {
                text: `\n\n[debug] search attempts: ${JSON.stringify(attempts)}`,
              });
            }
          } else {
            for (let i = 0; i < results.length; i += 1) {
              const r = results[i];
              const lines = [`${i + 1}.`];
              if (typeof r.title === "string" && r.title.trim()) {
                lines.push(r.title.trim());
              }
              if (typeof r.url === "string" && r.url.trim()) {
                lines.push(r.url.trim());
              }
              if (
                typeof r.snippet === "string" &&
                r.snippet.trim() &&
                r.snippet.trim() !== "..."
              ) {
                lines.push(r.snippet.trim());
              }
              send("delta", { text: `${lines.join("\n")}\n\n` });
            }
          }

          send("done", {
            ok: true,
            state: { lastSearch: lastSearchState },
          });
          controller.close();
          return;
        }

        // Deterministic support for pagination requests.
        if (shouldHandleMoreQuery(userMessage) && lastSearchState.query) {
          const nextLimit = lastSearchState.limit ?? DEFAULT_LIMIT;
          const nextOffset = (lastSearchState.offset ?? 0) + nextLimit;

          const toolResult = await executeTool(
            "smart_search_search",
            {
              query: lastSearchState.query,
              filter: lastSearchState.filter,
              limit: nextLimit,
              offset: nextOffset,
            },
            { mcpClient, lastSearchState },
          );

          const summary = {
            message:
              "Fetched more results using Smart Search MCP with increased offset.",
            toolResult,
          };

          send("delta", { text: "Here are more results:\n\n" });
          const results =
            (toolResult as { results?: SearchResultItem[] }).results ?? [];

          if (results.length === 0) {
            send("delta", { text: "No additional results were found." });
          } else {
            for (let i = 0; i < results.length; i += 1) {
              const r = results[i];
              const lines = [`${i + 1}.`];
              if (typeof r.title === "string" && r.title.trim()) {
                lines.push(r.title.trim());
              }
              if (typeof r.url === "string" && r.url.trim()) {
                lines.push(r.url.trim());
              }
              if (
                typeof r.snippet === "string" &&
                r.snippet.trim() &&
                r.snippet.trim() !== "..."
              ) {
                lines.push(r.snippet.trim());
              }
              send("delta", { text: `${lines.join("\n")}\n\n` });
            }
          }

          send("done", {
            ok: true,
            state: { lastSearch: lastSearchState },
            meta: summary,
          });
          controller.close();
          return;
        }

        // Deterministic support for summarize nth result requests.
        const nthSummary = shouldHandleSummarizeNth(userMessage);
        if (nthSummary && Array.isArray(lastSearchState.results)) {
          const candidate = lastSearchState.results[nthSummary.index];
          if (!candidate?.id) {
            send("delta", {
              text: "I could not find that result id in the previous search results.",
            });
            send("done", {
              ok: true,
              state: { lastSearch: lastSearchState },
            });
            controller.close();
            return;
          }

          const fetchResult = await executeTool(
            "smart_search_fetch",
            { id: candidate.id },
            { mcpClient, lastSearchState },
          );

          const promptMessages: OpenAIMessage[] = [
            {
              role: "system",
              content:
                "Summarize the provided fetched Smart Search document faithfully. Do not invent fields.",
            },
            {
              role: "user",
              content: `Please summarize this fetched result:\n${JSON.stringify(fetchResult)}`,
            },
          ];

          const completion = await openAiChatCompletion(promptMessages, model, []);
          const text =
            completion?.choices?.[0]?.message?.content ??
            "I fetched the document but could not generate a summary.";

          for (const chunk of chunkText(text)) {
            send("delta", { text: chunk });
          }

          send("done", {
            ok: true,
            state: { lastSearch: lastSearchState },
          });
          controller.close();
          return;
        }

        const messages: OpenAIMessage[] = [
          { role: "system", content: buildSystemPrompt() },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          {
            role: "assistant",
            content: `Previous search state: ${JSON.stringify(lastSearchState)}`,
          },
          { role: "user", content: userMessage },
        ];

        let finalText = "";

        for (let i = 0; i < 6; i += 1) {
          const completion = await openAiChatCompletion(messages, model, OPENAI_TOOLS);
          const choice = completion?.choices?.[0];
          const msg = choice?.message;

          if (!msg) {
            throw new Error("OpenAI returned no message.");
          }

          const assistantMessage: OpenAIMessage = {
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : undefined,
            tool_calls: Array.isArray(msg.tool_calls)
              ? (msg.tool_calls as OpenAIMessage["tool_calls"])
              : undefined,
          };

          messages.push(assistantMessage);

          const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
          if (toolCalls.length === 0) {
            finalText = msg.content ?? "I could not produce a response.";
            break;
          }

          send("status", {
            stage: "tool_call",
            toolNames: toolCalls.map((tc: { function: { name: string } }) => tc.function.name),
          });

          for (const toolCall of toolCalls) {
            const toolName = toolCall.function.name;
            let parsedArgs: unknown = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
            } catch {
              throw new Error(`Invalid JSON arguments for tool ${toolName}.`);
            }

            const toolResult = await executeTool(toolName, parsedArgs, {
              mcpClient,
              lastSearchState,
            });

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult),
            });
          }
        }

        if (!finalText) {
          finalText =
            "I could not complete the request within the tool-calling limit. Please refine your query.";
        }

        for (const chunk of chunkText(finalText)) {
          send("delta", { text: chunk });
        }

        send("done", {
          ok: true,
          state: { lastSearch: lastSearchState },
        });
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected server error.";
        send("error", { message });
        send("done", { ok: false });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

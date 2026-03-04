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
    "You are WP Admin Copilot for indexed content retrieval.",
    "You have access to Smart Search AI MCP with semantic/hybrid search capabilities.",
    "Available tools: smart_search_search (searches content) and smart_search_fetch (retrieves full document by ID).",
    "IMPORTANT: Smart Search AI uses vector/semantic search. Pass natural language queries directly to smart_search_search.",
    "Do NOT use filters unless explicitly needed. The 'query' parameter accepts full natural language.",
    "Examples: 'Return of the Jedi', 'Star Wars movies', 'posts about AI'.",
    "Smart Search AI handles semantic understanding, acronyms, and typos automatically.",
    "Present results with title, URL, and snippet. Never invent or modify these values.",
    "Use smart_search_fetch with a document id when users ask to summarize a specific result.",
    "If asked about users, roles, plugins, or settings, explain you only have access to indexed content.",
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

        // Deterministic guard: Handle pagination requests.
        if (shouldHandleMoreQuery(userMessage) && lastSearchState.query) {
          const nextLimit = lastSearchState.limit ?? DEFAULT_LIMIT;
          const nextOffset = (lastSearchState.offset ?? 0) + nextLimit;

          const toolResult = await executeTool(
            "smart_search_search",
            {
              query: lastSearchState.query,
              limit: nextLimit,
              offset: nextOffset,
            },
            { mcpClient, lastSearchState },
          );

          send("delta", { text: "Here are more results:\n\n" });
          const results =
            (toolResult as { results?: SearchResultItem[] }).results ?? [];

          if (results.length === 0) {
            send("delta", { text: "No additional results found." });
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

        // Deterministic guard: Handle summarize nth result requests.
        const nthSummary = shouldHandleSummarizeNth(userMessage);
        if (nthSummary && Array.isArray(lastSearchState.results)) {
          const candidate = lastSearchState.results[nthSummary.index];
          if (!candidate?.id) {
            send("delta", {
              text: "That result is not available in the previous search results.",
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
                "Summarize the provided document concisely. Use only information from the document.",
            },
            {
              role: "user",
              content: `Summarize this document:\n${JSON.stringify(fetchResult)}`,
            },
          ];

          const completion = await openAiChatCompletion(promptMessages, model, []);
          const text =
            completion?.choices?.[0]?.message?.content ??
            "Unable to generate summary.";

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

        // All other queries: Use OpenAI tool calling with Smart Search AI semantic search.

        const messages: OpenAIMessage[] = [
          { role: "system", content: buildSystemPrompt() },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: userMessage },
        ];

        let finalText = "";
        const maxIterations = 5;

        for (let i = 0; i < maxIterations; i += 1) {
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
            finalText = msg.content ?? "No response generated.";
            break;
          }

          send("status", {
            stage: "searching",
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
          finalText = "Unable to complete request. Please try rephrasing your query.";
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
        // Log full error server-side for debugging
        console.error("[API Error]", error);

        // Send sanitized error to client
        const message =
          process.env.NODE_ENV === "production"
            ? "An error occurred while processing your request."
            : error instanceof Error
              ? error.message
              : "Unexpected server error.";

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

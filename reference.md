# Smart Search AI MCP + OpenAI Agent + Next.js Copilot Reference

## A. Smart Search AI MCP Tools

### Tool: `search`

Searches the indexed WordPress content.

**Parameters**

- `query` (`string`, required): Keywords or natural language.
- `filter` (`string`, optional): Narrow results (for example, `status:published AND post_type:post`).
- `limit` (`number`, optional): Max results (default: `10`).
- `offset` (`number`, optional): Pagination offset.

**Typical MCP JSON-RPC Request**

```json
{
  "jsonrpc": "2.0",
  "id": "<unique id>",
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "Star Wars",
      "filter": "status:published AND post_type:post",
      "limit": 10
    }
  }
}
```

**Expected Response Shape (common)**

```json
{
  "jsonrpc": "2.0",
  "id": "<unique id>",
  "result": {
    "content": [
      {
        "type": "json",
        "json": {
          "results": [
            {
              "title": "Star Wars Analysis",
              "url": "https://site.com/star-wars-analysis/",
              "id": "12345",
              "snippet": " ... "
            }
          ]
        }
      }
    ]
  }
}
```

### Tool: `fetch`

Retrieves the full content of a document by ID.

**Parameters**

- `id` (`string`, required): Document ID returned by `search`.

**Typical MCP JSON-RPC Request**

```json
{
  "jsonrpc": "2.0",
  "id": "<unique id>",
  "method": "tools/call",
  "params": {
    "name": "fetch",
    "arguments": {
      "id": "12345"
    }
  }
}
```

**Typical `fetch` Response**

Returns document content including text, metadata, and structured fields.

## B. OpenAI Agent Builder Tool Calling

This reference shows how to define function tools for OpenAI.

**Tool Definition (TypeScript)**

```ts
const smart_search_search_tool = {
  type: "function" as const,
  function: {
    name: "smart_search_search",
    description:
      "Searches indexed WordPress content via Smart Search AI MCP and returns results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        filter: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
};

const smart_search_fetch_tool = {
  type: "function" as const,
  function: {
    name: "smart_search_fetch",
    description:
      "Fetches full document content by ID from Smart Search AI MCP.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  }
};
```

**Tool Calling Pattern**

```ts
const completion = await openai.chat.completions.create({
  model: MODEL,
  messages,
  tools: [smart_search_search_tool, smart_search_fetch_tool],
  tool_choice: "auto",
  temperature: 0.2
});
```

If the model chooses a tool call, the response includes:

- `message.tool_calls[i].function.name`
- `message.tool_calls[i].function.arguments`

**Example**

```json
{
  "tool_calls": [
    {
      "type": "function",
      "id": "tool_call_1",
      "function": {
        "name": "smart_search_search",
        "arguments": "{\"query\":\"Star Wars\",\"filter\":\"status:published AND post_type:post\",\"limit\":10}"
      }
    }
  ]
}
```

Your agent code should:

- Parse JSON arguments.
- Execute MCP call.
- Append tool result as a new message with:
  - `role: "tool"`
  - `tool_call_id`
  - `content: JSON.stringify(toolResult)`

## C. Next.js Streaming (Server-Side Events)

This reference shows how to implement SSE in a Next.js App Router endpoint.

**SSE Response**

The API must return a `ReadableStream` with headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `access-control-allow-origin: <origin>`

**SSE Frame Format**

Each message frame uses:

- `event: <eventName>`
- `data: <json-stringified-payload>`

Examples:

```txt
event: status
data: {"stage":"thinking"}

event: delta
data: {"text":"Here is a post about ..."}

event: done
data: {"ok":true}
```

**Helper Function**

```ts
function sseFormat(event: string, payload: any) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
```

## D. Minimal JSON-RPC 2.0 Spec

For MCP requests, use this pattern:

```json
{
  "jsonrpc": "2.0",
  "id": "<any unique string>",
  "method": "tools/call",
  "params": {
    "name": "<tool name>",
    "arguments": { "...": "..." }
  }
}
```

The server may also support:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/list"
}
```

For this project, discovery can be skipped since tool names are known (`search`, `fetch`).

## E. Smart Search Filtering Best Practices

Use `filter` to narrow results.

Examples:

- `status:published AND post_type:post`
- `author:"Jane Doe" AND status:published`
- `(post_type:post OR post_type:page) AND status:published`

Supported operators:

- `AND`
- `OR`
- `NOT`

## F. CORS and Security Notes

When calling the Next.js agent from WP Admin, include header:

```txt
x-wp-admin-copilot-token: <shared secret>
```

Next.js should only accept requests from:

```txt
Origin: https://your-wordpress-site.com
```

Always validate both.

## G. Minimal OpenAI Completion Pattern

```ts
const completion = await openai.chat.completions.create({
  model: MODEL,
  messages: [...],
  tools: [...],
  tool_choice: "auto",
  temperature: 0.2,
});
```

Preferred low temperature ensures consistency.

## H. Post-Search Normalization

When MCP `search` returns results, extract:

- `title`
- `url`
- `id` (optional)
- `snippet` (optional)

Use these fields when:

- presenting results
- feeding into `fetch` if full content is needed

## I. Useful Tips

- If the model returns no tools, it means a final answer was generated.
- For multi-step reasoning, the agent pattern may require several tool calls.
- Always validate tool arguments before sending to MCP.
- Always handle MCP errors gracefully.

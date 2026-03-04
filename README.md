# WP Admin Copilot - Smart Search AI

A Next.js API backend that powers an AI-driven WordPress admin assistant using OpenAI and WP Engine's Smart Search AI MCP.

## Architecture

```
WordPress Admin (User)
    ↓
WP Admin Copilot Plugin (PHP/JS)
    ↓
Next.js API (this project) ← OpenAI API
    ↓
Smart Search AI MCP Server
    ↓
WordPress Content (indexed)
```

### Components

- **OpenAI API**: Natural language understanding and tool orchestration
- **Smart Search AI MCP**: Semantic/hybrid search engine for WordPress content
- **Next.js API**: Coordinator that connects OpenAI to Smart Search AI
- **WP Admin Plugin**: Frontend interface in WordPress admin dashboard

## Features

- 🔍 **Semantic Search**: Natural language queries ("Find posts about Star Wars")
- 🤖 **AI-Powered**: OpenAI understands intent and formats responses
- 📄 **Document Retrieval**: Fetch and summarize specific search results
- 🔐 **Secure**: CORS + token authentication
- 📡 **Streaming**: Server-Sent Events for real-time responses

## Setup

### Prerequisites

- Node.js 20+
- WP Engine account with Smart Search AI enabled
- OpenAI API key
- WordPress site with WP Admin Copilot plugin installed

### Installation

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local` with your credentials:
   - `OPENAI_API_KEY`: Get from https://platform.openai.com/api-keys
   - `SMART_SEARCH_MCP_URL`: Your Smart Search AI MCP endpoint
   - `WP_ADMIN_COPILOT_TOKEN`: Generate with `openssl rand -hex 32`
   - `WP_ADMIN_ORIGIN`: Your WordPress site URL

3. **Start development server**
   ```bash
   npm run dev
   ```

   API will be available at: http://localhost:3000/api/chat

4. **Configure WordPress plugin**

   In WordPress Admin → WP Copilot → Settings:
   - **Agent Endpoint URL**: `http://localhost:3000/api/chat` (or your production URL)
   - **Shared Secret Token**: Same value as `WP_ADMIN_COPILOT_TOKEN`

## API Endpoints

### `POST /api/chat`

Main endpoint for chat interactions.

**Request:**
```json
{
  "message": "Find posts about Star Wars",
  "history": [
    { "role": "user", "content": "previous message" },
    { "role": "assistant", "content": "previous response" }
  ],
  "state": {
    "lastSearch": {
      "query": "Star Wars",
      "results": [...]
    }
  }
}
```

**Response:** Server-Sent Events stream

```
event: status
data: {"stage":"thinking"}

event: delta
data: {"text":"Here are the results..."}

event: done
data: {"ok":true,"state":{...}}
```

### `GET /api/health`

Health check endpoint for monitoring.

**Response:**
```json
{
  "ok": true,
  "timestamp": "2024-03-04T12:00:00.000Z"
}
```

## Development

```bash
# Development with hot reload
npm run dev

# Type checking
npm run build

# Linting
npm run lint
```

## Production Deployment

### Environment Variables

Ensure all variables from `.env.example` are configured in your production environment.

### Build

```bash
npm run build
npm run start
```

### Security Checklist

- ✅ Set strong `WP_ADMIN_COPILOT_TOKEN` (32+ random characters)
- ✅ Configure correct `WP_ADMIN_ORIGIN` (exact WordPress URL)
- ✅ Use HTTPS in production
- ✅ Keep `OPENAI_API_KEY` secure
- ✅ Review CORS settings

## Project Structure

```
wp-openai-route/
├── app/
│   ├── api/
│   │   ├── chat/route.ts      # Main chat endpoint
│   │   └── health/route.ts    # Health check
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── mcp.ts                 # Smart Search AI MCP client
│   └── tools.ts               # OpenAI tool definitions
├── wordpress-plugin/
│   ├── wp-admin-copilot.php   # WordPress plugin
│   └── copilot.js             # Frontend JavaScript
├── .env.example               # Environment template
└── reference.md               # Technical reference
```

## Troubleshooting

### "Invalid session ID" errors
Smart Search AI MCP requires session initialization. This is handled automatically with retry logic.

### "No results found"
- Ensure Smart Search AI has indexed your WordPress content
- Check that `SMART_SEARCH_MCP_URL` is correct
- Verify semantic search is enabled in Smart Search AI settings

### CORS errors
- Verify `WP_ADMIN_ORIGIN` matches your WordPress URL exactly
- Check that request includes `x-wp-admin-copilot-token` header

## Reference

See [reference.md](./reference.md) for detailed API documentation and examples.

## License

Private project.

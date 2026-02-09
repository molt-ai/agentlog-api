# AgentLog API

Backend API for [AgentLog Mobile](https://github.com/molt-ai/agentlog-mobile) — real-time AI agent observability.

## 🔥 Universal AI Proxy

**One endpoint, any provider, automatic logging.** Just change your `baseURL` and every AI call is automatically tracked.

### Quick Start

```javascript
// OpenAI SDK
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://agentlog-api.fly.dev/v1',
  apiKey: 'agentlog_xxx',  // Your AgentLog API key
  defaultHeaders: {
    'X-Provider-Key': 'sk-xxx'  // Your actual OpenAI key
  }
});

// Use normally - all calls are logged automatically!
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Supported Providers

| Provider | Models | Auto-detected from |
|----------|--------|-------------------|
| **OpenAI** | gpt-4, gpt-4o, gpt-3.5-turbo, o1-* | `gpt-*`, `o1*` |
| **Anthropic** | claude-3-opus, claude-3-sonnet, claude-3-haiku | `claude-*` |
| **Google** | gemini-pro, gemini-1.5-pro, gemini-1.5-flash | `gemini-*` |
| **xAI** | grok-2, grok-beta | `grok-*` |
| **OpenRouter** | any model | `provider/model` format |

### Anthropic Example

```javascript
// Works with Anthropic models too!
const response = await openai.chat.completions.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Hello Claude!' }]
});
// AgentLog auto-converts to Anthropic format and back
```

### Streaming

```javascript
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Write a story' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
// Full response is logged when stream completes
```

### Use with Cursor, Continue, etc.

Any OpenAI-compatible tool works:

```json
// .cursor/settings.json
{
  "openai.apiBase": "https://agentlog-api.fly.dev/v1",
  "openai.apiKey": "agentlog_xxx"
}
```

Then set `X-Provider-Key` header in your tool's custom headers.

### What Gets Logged

Every proxy call automatically tracks:
- ✅ Model used
- ✅ Input/output tokens
- ✅ Cost (calculated from token usage)
- ✅ Duration
- ✅ Full prompt and completion
- ✅ Success/failure status
- ✅ Provider errors

### cURL Example

```bash
curl https://agentlog-api.fly.dev/v1/chat/completions \
  -H "Authorization: Bearer agentlog_xxx" \
  -H "X-Provider-Key: sk-openai-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## 🚀 Deployment

Deployed on [Fly.io](https://fly.io) at `https://agentlog-api.fly.dev`

```bash
fly deploy
```

## 📡 Endpoints

### Universal AI Proxy
```
POST /v1/chat/completions
Authorization: Bearer YOUR_AGENTLOG_KEY
X-Provider-Key: YOUR_PROVIDER_API_KEY (OpenAI, Anthropic, etc.)

{
  "model": "gpt-4o",  // or claude-3-sonnet, gemini-pro, etc.
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}
```

### List Available Models
```
GET /v1/models
Authorization: Bearer YOUR_API_KEY
```

### Health Check
```
GET /
```

### Get API Key
```
GET /api/key
```

### Track Task (One-Shot)
```
POST /api/track
Authorization: Bearer YOUR_API_KEY

{
  "agent": "MyBot",
  "task": "Send email",
  "status": "success",  // pending | running | success | failed | slow
  "durationMs": 1234,
  "cost": 0.002,
  "error": null,
  "provider": "openai",
  "model": "gpt-4",
  "prompt": "...",
  "completion": "...",
  "tokens_in": 100,
  "tokens_out": 50
}
```

### Start Task (Real-Time)
```
POST /api/tasks/start
Authorization: Bearer YOUR_API_KEY

{
  "agent": "MyBot",
  "task": "Process document"
}

Response:
{
  "success": true,
  "taskId": "uuid",
  "traceId": "uuid",
  "startTime": "2024-01-01T00:00:00Z"
}
```

### Complete Task
```
POST /api/tasks/:id/complete
Authorization: Bearer YOUR_API_KEY

{
  "status": "success",  // success | failed | slow
  "durationMs": 2500,
  "cost": 0.003,
  "model": "gpt-4",
  "prompt": "...",
  "completion": "..."
}
```

### Get Tasks
```
GET /api/tasks?limit=100&since=2024-01-01
Authorization: Bearer YOUR_API_KEY
```

### Get Traces
```
GET /api/traces?limit=50
Authorization: Bearer YOUR_API_KEY
```

### Get Single Trace
```
GET /api/traces/:traceId
Authorization: Bearer YOUR_API_KEY
```

## 🏗️ Tech Stack

- **Runtime:** Node.js + Express
- **Database:** SQLite (better-sqlite3)
- **Hosting:** Fly.io

## 🔧 Local Development

```bash
npm install
node index.js
```

Server runs on `http://localhost:3000`

## 📋 Database Schema

```sql
-- Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  agent_name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,  -- pending | running | success | failed | slow
  duration_ms INTEGER NOT NULL,
  cost REAL DEFAULT 0,
  error TEXT,
  provider TEXT DEFAULT 'custom',
  model TEXT,
  prompt TEXT,
  completion TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  trace_id TEXT,
  parent_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- API Keys
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT 'Default',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
```

## 📄 License

MIT

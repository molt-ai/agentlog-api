# AgentLog API

Backend API for [AgentLog Mobile](https://github.com/molt-ai/agentlog-mobile) — real-time AI agent observability.

## 🚀 Deployment

Deployed on [Fly.io](https://fly.io) at `https://agentlog-api.fly.dev`

```bash
fly deploy
```

## 📡 Endpoints

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

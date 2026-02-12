const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const dbPath = process.env.DATABASE_PATH || './agentlog.db';
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT 'Default',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  );
  
  -- NEW: Account system based on provider key hashes
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_accounts_key_hash ON accounts(key_hash);
  
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    account_id TEXT,
    agent_name TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'slow')),
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER NOT NULL,
    cost REAL DEFAULT 0,
    error TEXT,
    provider TEXT DEFAULT 'custom',
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- Full request/response logging
    model TEXT,
    prompt TEXT,
    completion TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    -- Trace support (parent-child relationships)
    trace_id TEXT,
    parent_id TEXT,
    span_name TEXT,
    -- Prompt versioning
    prompt_version TEXT,
    prompt_template_id TEXT,
    -- Original request for replay
    original_request TEXT
  );
  
  -- Prompt templates for versioning
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    account_id TEXT,
    name TEXT NOT NULL,
    template TEXT NOT NULL,
    variables TEXT DEFAULT '[]',
    version INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metrics TEXT DEFAULT '{}'
  );
  
  CREATE INDEX IF NOT EXISTS idx_tasks_api_key ON tasks(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_trace_id ON tasks(trace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_templates_api_key ON prompt_templates(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_running ON tasks(status) WHERE status IN ('pending', 'running');
`);

// Create default API key if none exists (for backward compatibility)
const existingKey = db.prepare('SELECT * FROM api_keys LIMIT 1').get();
if (!existingKey) {
  const defaultKey = 'agentlog_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)').run(
    crypto.randomUUID(),
    defaultKey,
    'Default Key'
  );
  console.log('Created default API key:', defaultKey);
}

// ===== HELPERS =====

// Detect provider from API key prefix
function detectProviderFromKey(key) {
  if (!key) return null;
  
  // OpenAI keys: sk-... (but not sk-ant-)
  if (key.startsWith('sk-') && !key.startsWith('sk-ant-')) return 'openai';
  
  // Anthropic keys: sk-ant-...
  if (key.startsWith('sk-ant-')) return 'anthropic';
  
  // Google/Gemini keys: AIza...
  if (key.startsWith('AIza')) return 'google';
  
  // xAI/Grok keys: xai-...
  if (key.startsWith('xai-')) return 'xai';
  
  return null;
}

// Detect provider from model name (fallback)
function detectProviderFromModel(model) {
  if (!model) return 'openai';
  model = model.toLowerCase();
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.includes('openai')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('grok-')) return 'xai';
  if (model.includes('/')) return 'openrouter';
  return 'openai';
}

// Hash a key using SHA256
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Get or create account from key hash
function getOrCreateAccount(keyHash, provider) {
  let account = db.prepare('SELECT * FROM accounts WHERE key_hash = ?').get(keyHash);
  
  if (!account) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO accounts (id, key_hash, provider, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      keyHash,
      provider,
      new Date().toISOString()
    );
    account = { id, key_hash: keyHash, provider, created: true };
  }
  
  // Update last_seen
  db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    account.id
  );
  
  return account;
}

// ===== MIDDLEWARE =====

// Validate API key (legacy AgentLog keys)
const validateApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  
  const key = authHeader.replace('Bearer ', '');
  
  // First try legacy AgentLog key
  const apiKey = db.prepare('SELECT * FROM api_keys WHERE key = ?').get(key);
  
  if (apiKey) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      apiKey.id
    );
    req.apiKey = apiKey;
    req.authType = 'legacy';
    return next();
  }
  
  // Try provider key (hash it and look up account)
  const provider = detectProviderFromKey(key);
  if (provider) {
    const keyHash = hashKey(key);
    const account = getOrCreateAccount(keyHash, provider);
    req.account = account;
    req.providerKey = key;
    req.authType = 'provider';
    return next();
  }
  
  return res.status(401).json({ error: 'Invalid API key' });
};

// Get account ID (works with both auth types)
function getAccountId(req) {
  if (req.authType === 'provider' && req.account) {
    return req.account.id;
  }
  if (req.authType === 'legacy' && req.apiKey) {
    return req.apiKey.id;
  }
  return null;
}

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'AgentLog API',
    version: '2.0.0',
    features: ['provider-key-auth', 'proxy', 'traces']
  });
});

// Get API key info (legacy)
app.get('/api/key', (req, res) => {
  const apiKey = db.prepare('SELECT key, name FROM api_keys LIMIT 1').get();
  res.json(apiKey);
});

// ===== NEW: Account lookup endpoint =====
app.post('/api/account/lookup', (req, res) => {
  const { key_hash, provider } = req.body;
  
  if (!key_hash || !provider) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['key_hash', 'provider']
    });
  }
  
  // Validate provider
  const validProviders = ['openai', 'anthropic', 'google', 'xai'];
  if (!validProviders.includes(provider)) {
    return res.status(400).json({ error: 'Invalid provider. Must be: ' + validProviders.join(', ') });
  }
  
  let account = db.prepare('SELECT * FROM accounts WHERE key_hash = ?').get(key_hash);
  let created = false;
  
  if (!account) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO accounts (id, key_hash, provider, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      key_hash,
      provider,
      new Date().toISOString()
    );
    account = { id, key_hash, provider };
    created = true;
    console.log(`[ACCOUNT] Created new account for ${provider}: ${id.substring(0, 8)}...`);
  } else {
    // Update last_seen
    db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      account.id
    );
  }
  
  res.json({ 
    account_id: account.id,
    provider: account.provider,
    created
  });
});

// Track a task (with full request/response support)
app.post('/api/track', validateApiKey, (req, res) => {
  const { 
    agent, task, status, durationMs, cost, error, provider, metadata,
    model, prompt, completion, tokens_in, tokens_out,
    trace_id, parent_id, span_name,
    prompt_version, prompt_template_id
  } = req.body;
  
  if (!agent || !task || !status || durationMs === undefined) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['agent', 'task', 'status', 'durationMs']
    });
  }
  
  if (!['pending', 'running', 'success', 'failed', 'slow'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: pending, running, success, failed, or slow' });
  }
  
  const id = crypto.randomUUID();
  const generatedTraceId = trace_id || crypto.randomUUID();
  const accountId = getAccountId(req);
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, account_id, agent_name, description, status, duration_ms, cost, error, provider, metadata, created_at,
      model, prompt, completion, tokens_in, tokens_out,
      trace_id, parent_id, span_name,
      prompt_version, prompt_template_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.apiKey?.id || null,
    accountId,
    agent,
    task,
    status,
    durationMs,
    cost || 0,
    error || null,
    provider || 'custom',
    JSON.stringify(metadata || {}),
    new Date().toISOString(),
    model || null,
    prompt || null,
    completion || null,
    tokens_in || 0,
    tokens_out || 0,
    generatedTraceId,
    parent_id || null,
    span_name || null,
    prompt_version || null,
    prompt_template_id || null
  );
  
  console.log(`[TASK] ${status.toUpperCase()} | ${agent} | ${task}${model ? ` | ${model}` : ''}`);
  
  res.json({ 
    success: true, 
    taskId: id,
    traceId: generatedTraceId,
    message: 'Task logged successfully'
  });
});

// Start a task (creates with running status)
app.post('/api/tasks/start', validateApiKey, (req, res) => {
  const { agent, task, provider, metadata, trace_id, parent_id, span_name } = req.body;
  
  if (!agent || !task) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['agent', 'task']
    });
  }
  
  const id = crypto.randomUUID();
  const generatedTraceId = trace_id || crypto.randomUUID();
  const now = new Date().toISOString();
  const accountId = getAccountId(req);
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, account_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      trace_id, parent_id, span_name, started_at
    )
    VALUES (?, ?, ?, ?, ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.apiKey?.id || null,
    accountId,
    agent,
    task,
    provider || 'custom',
    JSON.stringify(metadata || {}),
    now,
    generatedTraceId,
    parent_id || null,
    span_name || null,
    now
  );
  
  console.log(`[TASK] STARTED | ${agent} | ${task}`);
  
  res.json({ 
    success: true, 
    taskId: id,
    traceId: generatedTraceId,
    startTime: now,
    message: 'Task started - use complete endpoint to finalize'
  });
});

// Complete a running task
app.post('/api/tasks/:id/complete', validateApiKey, (req, res) => {
  const { status, durationMs, cost, error, model, prompt, completion, tokens_in, tokens_out, metadata } = req.body;
  
  if (!status || durationMs === undefined) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['status', 'durationMs']
    });
  }
  
  if (!['success', 'failed', 'slow'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: success, failed, or slow' });
  }
  
  const now = new Date().toISOString();
  const accountId = getAccountId(req);
  
  // Support both legacy and new auth
  const result = db.prepare(`
    UPDATE tasks SET 
      status = ?, duration_ms = ?, cost = ?, error = ?,
      model = ?, prompt = ?, completion = ?, tokens_in = ?, tokens_out = ?,
      metadata = ?, completed_at = ?
    WHERE id = ? AND (api_key_id = ? OR account_id = ?) AND status = 'running'
  `).run(
    status,
    durationMs,
    cost || 0,
    error || null,
    model || null,
    prompt || null,
    completion || null,
    tokens_in || 0,
    tokens_out || 0,
    JSON.stringify(metadata || {}),
    now,
    req.params.id,
    req.apiKey?.id || null,
    accountId
  );
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Task not found or not in running state' });
  }
  
  console.log(`[TASK] ${status.toUpperCase()} | Task ${req.params.id}`);
  
  res.json({ 
    success: true, 
    taskId: req.params.id,
    status: status,
    message: 'Task completed successfully'
  });
});

// Get tasks
app.get('/api/tasks', validateApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const since = req.query.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const accountId = getAccountId(req);
  
  const tasks = db.prepare(`
    SELECT * FROM tasks 
    WHERE (api_key_id = ? OR account_id = ?) AND created_at > ?
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.apiKey?.id || null, accountId, since, limit);
  
  res.json(tasks);
});

// Get single task with full details
app.get('/api/tasks/:id', validateApiKey, (req, res) => {
  const accountId = getAccountId(req);
  
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND (api_key_id = ? OR account_id = ?)
  `).get(req.params.id, req.apiKey?.id || null, accountId);
  
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  res.json(task);
});

// ===== TRACES =====
app.get('/api/traces', validateApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const accountId = getAccountId(req);
  
  const traces = db.prepare(`
    SELECT 
      trace_id,
      MIN(created_at) as started_at,
      MAX(created_at) as ended_at,
      COUNT(*) as span_count,
      SUM(duration_ms) as total_duration_ms,
      SUM(cost) as total_cost,
      SUM(tokens_in) as total_tokens_in,
      SUM(tokens_out) as total_tokens_out,
      GROUP_CONCAT(DISTINCT agent_name) as agents,
      GROUP_CONCAT(DISTINCT model) as models,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_spans,
      MAX(CASE WHEN parent_id IS NULL THEN description ELSE NULL END) as root_description
    FROM tasks 
    WHERE (api_key_id = ? OR account_id = ?) AND created_at > ? AND trace_id IS NOT NULL
    GROUP BY trace_id
    ORDER BY started_at DESC
    LIMIT ?
  `).all(req.apiKey?.id || null, accountId, since, limit);
  
  res.json(traces);
});

app.get('/api/traces/:traceId', validateApiKey, (req, res) => {
  const accountId = getAccountId(req);
  
  const spans = db.prepare(`
    SELECT * FROM tasks 
    WHERE trace_id = ? AND (api_key_id = ? OR account_id = ?)
    ORDER BY created_at ASC
  `).all(req.params.traceId, req.apiKey?.id || null, accountId);
  
  if (spans.length === 0) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  
  const spanMap = {};
  const roots = [];
  
  spans.forEach(span => {
    spanMap[span.id] = { ...span, children: [] };
  });
  
  spans.forEach(span => {
    if (span.parent_id && spanMap[span.parent_id]) {
      spanMap[span.parent_id].children.push(spanMap[span.id]);
    } else {
      roots.push(spanMap[span.id]);
    }
  });
  
  const summary = {
    trace_id: req.params.traceId,
    span_count: spans.length,
    total_duration_ms: spans.reduce((sum, s) => sum + s.duration_ms, 0),
    total_cost: spans.reduce((sum, s) => sum + (s.cost || 0), 0),
    total_tokens_in: spans.reduce((sum, s) => sum + (s.tokens_in || 0), 0),
    total_tokens_out: spans.reduce((sum, s) => sum + (s.tokens_out || 0), 0),
    started_at: spans[0].created_at,
    ended_at: spans[spans.length - 1].created_at,
    has_failures: spans.some(s => s.status === 'failed')
  };
  
  res.json({ summary, tree: roots, spans });
});

// ===== PROMPT VERSIONING =====
app.post('/api/prompts', validateApiKey, (req, res) => {
  const { name, template, variables } = req.body;
  
  if (!name || !template) {
    return res.status(400).json({ error: 'name and template are required' });
  }
  
  const accountId = getAccountId(req);
  
  const existing = db.prepare(`
    SELECT * FROM prompt_templates WHERE (api_key_id = ? OR account_id = ?) AND name = ? AND is_active = 1
  `).get(req.apiKey?.id || null, accountId, name);
  
  const id = crypto.randomUUID();
  const version = existing ? existing.version + 1 : 1;
  
  if (existing) {
    db.prepare(`UPDATE prompt_templates SET is_active = 0 WHERE id = ?`).run(existing.id);
  }
  
  db.prepare(`
    INSERT INTO prompt_templates (id, api_key_id, account_id, name, template, variables, version, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    req.apiKey?.id || null,
    accountId,
    name,
    template,
    JSON.stringify(variables || []),
    version,
    new Date().toISOString()
  );
  
  res.json({ 
    id, 
    name, 
    version, 
    message: `Prompt template ${existing ? 'updated' : 'created'} (v${version})`
  });
});

app.get('/api/prompts', validateApiKey, (req, res) => {
  const includeInactive = req.query.all === 'true';
  const accountId = getAccountId(req);
  
  const prompts = db.prepare(`
    SELECT * FROM prompt_templates 
    WHERE (api_key_id = ? OR account_id = ?) ${includeInactive ? '' : 'AND is_active = 1'}
    ORDER BY name, version DESC
  `).all(req.apiKey?.id || null, accountId);
  
  res.json(prompts);
});

app.get('/api/prompts/:name', validateApiKey, (req, res) => {
  const accountId = getAccountId(req);
  
  const versions = db.prepare(`
    SELECT * FROM prompt_templates 
    WHERE (api_key_id = ? OR account_id = ?) AND name = ?
    ORDER BY version DESC
  `).all(req.apiKey?.id || null, accountId, req.params.name);
  
  if (versions.length === 0) {
    return res.status(404).json({ error: 'Prompt template not found' });
  }
  
  const versionsWithMetrics = versions.map(v => {
    const metrics = db.prepare(`
      SELECT 
        COUNT(*) as usage_count,
        AVG(duration_ms) as avg_duration,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
        SUM(cost) as total_cost
      FROM tasks
      WHERE (api_key_id = ? OR account_id = ?) AND prompt_template_id = ?
    `).get(req.apiKey?.id || null, accountId, v.id);
    
    return { ...v, metrics };
  });
  
  res.json({
    name: req.params.name,
    current_version: versions[0].version,
    versions: versionsWithMetrics
  });
});

// Health metrics
app.get('/api/health', validateApiKey, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const accountId = getAccountId(req);
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_tasks,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_tasks,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
      SUM(CASE WHEN status = 'slow' THEN 1 ELSE 0 END) as slow_tasks,
      AVG(duration_ms) as avg_duration_ms,
      SUM(cost) as total_cost,
      SUM(CASE WHEN status = 'failed' THEN cost ELSE 0 END) as wasted_cost
    FROM tasks
    WHERE (api_key_id = ? OR account_id = ?) AND created_at > ?
  `).get(req.apiKey?.id || null, accountId, since);
  
  res.json(stats);
});

// Failure patterns
app.get('/api/failures', validateApiKey, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const accountId = getAccountId(req);
  
  const patterns = db.prepare(`
    SELECT 
      COALESCE(error, 'Unknown error') as error_type,
      COUNT(*) as count,
      GROUP_CONCAT(description, ', ') as examples
    FROM tasks
    WHERE (api_key_id = ? OR account_id = ?) AND created_at > ? AND status = 'failed'
    GROUP BY error_type
    ORDER BY count DESC
    LIMIT 10
  `).all(req.apiKey?.id || null, accountId, since);
  
  res.json(patterns);
});

// Task evaluation endpoint
app.get('/api/tasks/:id/evaluate', validateApiKey, (req, res) => {
  const accountId = getAccountId(req);
  
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND (api_key_id = ? OR account_id = ?)
  `).get(req.params.id, req.apiKey?.id || null, accountId);
  
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  const scores = scoreCompletion(task);
  const suggestions = generateSuggestions(task);
  
  res.json({
    task,
    evaluation: {
      scores,
      suggestions,
      evaluated_at: new Date().toISOString()
    }
  });
});

// Quality scoring helpers
const scoreCompletion = (task) => {
  if (!task.completion) return null;
  
  const prompt = task.prompt || '';
  const completion = task.completion || '';
  
  let scores = { relevance: 0, conciseness: 0, completeness: 0, overall: 0 };
  
  const promptWords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const completionLower = completion.toLowerCase();
  const matchedWords = promptWords.filter(w => completionLower.includes(w));
  scores.relevance = Math.min(100, Math.round((matchedWords.length / Math.max(promptWords.length, 1)) * 100 + 40));
  
  const completionLength = completion.length;
  const promptLength = prompt.length;
  const ratio = completionLength / Math.max(promptLength, 1);
  if (ratio < 0.5) scores.conciseness = 60;
  else if (ratio > 10) scores.conciseness = 50;
  else if (ratio > 5) scores.conciseness = 70;
  else scores.conciseness = 90;
  
  const hasIncomplete = completion.endsWith('...') || completion.includes('I cannot') || completion.includes("I'm not sure");
  scores.completeness = hasIncomplete ? 60 : 85;
  
  if (completion.includes('\n') || completion.includes('1.') || completion.includes('•')) {
    scores.completeness = Math.min(100, scores.completeness + 10);
  }
  
  scores.overall = Math.round(scores.relevance * 0.4 + scores.conciseness * 0.3 + scores.completeness * 0.3);
  
  return scores;
};

const generateSuggestions = (task) => {
  const suggestions = [];
  const prompt = task.prompt || '';
  const completion = task.completion || '';
  const error = task.error || '';
  
  if (task.status === 'failed') {
    if (error.toLowerCase().includes('timeout')) {
      suggestions.push({ type: 'error_fix', priority: 'high', title: 'Reduce context size', description: 'Timeout errors often mean the context is too large.', icon: '⏱️' });
    }
    if (error.toLowerCase().includes('rate limit')) {
      suggestions.push({ type: 'error_fix', priority: 'high', title: 'Add retry with backoff', description: 'Implement exponential backoff between retries.', icon: '🔄' });
    }
  }
  
  if (prompt.length < 50) {
    suggestions.push({ type: 'prompt_improvement', priority: 'medium', title: 'Add more context', description: 'Short prompts often lead to vague responses.', icon: '📝' });
  }
  
  if (completion && completion.length > 2000) {
    suggestions.push({ type: 'response_optimization', priority: 'medium', title: 'Request concise output', description: 'Add "Be concise" to reduce token usage.', icon: '💰' });
  }
  
  return suggestions;
};

// Retry task endpoint
app.post('/api/tasks/:id/retry', validateApiKey, (req, res) => {
  const accountId = getAccountId(req);
  
  const originalTask = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND (api_key_id = ? OR account_id = ?)
  `).get(req.params.id, req.apiKey?.id || null, accountId);
  
  if (!originalTask) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  const { modified_prompt } = req.body;
  const retryId = crypto.randomUUID();
  const retryTraceId = crypto.randomUUID();
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, account_id, agent_name, description, status, duration_ms, cost, error, provider, metadata, created_at,
      model, prompt, completion, tokens_in, tokens_out, trace_id, parent_id, span_name
    )
    VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, 'retry')
  `).run(
    retryId,
    req.apiKey?.id || null,
    accountId,
    originalTask.agent_name,
    `[RETRY] ${originalTask.description}`,
    originalTask.provider,
    JSON.stringify({ original_task_id: originalTask.id, retry_reason: 'manual_retry', modified_prompt: !!modified_prompt }),
    new Date().toISOString(),
    originalTask.model,
    modified_prompt || originalTask.prompt,
    retryTraceId,
    originalTask.id
  );
  
  res.json({
    success: true,
    retry_task_id: retryId,
    original_task_id: originalTask.id,
    message: 'Retry task created.',
    prompt_used: modified_prompt || originalTask.prompt
  });
});

// ===== UNIVERSAL AI PROXY =====

const MODEL_COSTS = {
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-32k': { input: 0.06, output: 0.12 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'o1-preview': { input: 0.015, output: 0.06 },
  'o1-mini': { input: 0.003, output: 0.012 },
  'o1': { input: 0.015, output: 0.06 },
  'claude-3-5-sonnet-20240620': { input: 0.003, output: 0.015 },
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-5-haiku-20241022': { input: 0.001, output: 0.005 },
  'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
  'claude-3-sonnet-20240229': { input: 0.003, output: 0.015 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
  'gemini-pro': { input: 0.00025, output: 0.0005 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  'grok-beta': { input: 0.005, output: 0.015 },
  'grok-2': { input: 0.002, output: 0.01 },
};

function calculateCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    const matchedKey = Object.keys(MODEL_COSTS).find(key => model.includes(key) || key.includes(model));
    if (matchedKey) {
      const matchedCosts = MODEL_COSTS[matchedKey];
      return (inputTokens / 1000) * matchedCosts.input + (outputTokens / 1000) * matchedCosts.output;
    }
    return 0;
  }
  return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
}

function getProviderEndpoint(provider) {
  const endpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    google: 'https://generativelanguage.googleapis.com/v1beta/models',
    xai: 'https://api.x.ai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions'
  };
  return endpoints[provider] || endpoints.openai;
}

function convertToAnthropic(openaiRequest) {
  const { model, messages, max_tokens, temperature, stream } = openaiRequest;
  const systemMessage = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  
  return {
    model: model,
    max_tokens: max_tokens || 4096,
    messages: otherMessages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ...(systemMessage && { system: systemMessage.content }),
    ...(temperature !== undefined && { temperature }),
    stream: stream || false
  };
}

function convertFromAnthropic(anthropicResponse, model) {
  return {
    id: anthropicResponse.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: anthropicResponse.content?.[0]?.text || '' }, finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop' : anthropicResponse.stop_reason }],
    usage: { prompt_tokens: anthropicResponse.usage?.input_tokens || 0, completion_tokens: anthropicResponse.usage?.output_tokens || 0, total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0) }
  };
}

function convertToGemini(openaiRequest) {
  const { messages, max_tokens, temperature } = openaiRequest;
  const systemMessage = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  
  return {
    contents: otherMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    ...(systemMessage && { systemInstruction: { parts: [{ text: systemMessage.content }] } }),
    generationConfig: { ...(max_tokens && { maxOutputTokens: max_tokens }), ...(temperature !== undefined && { temperature }) }
  };
}

function convertFromGemini(geminiResponse, model) {
  const candidate = geminiResponse.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text || '';
  return {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : 'length' }],
    usage: { prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0, completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0, total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0 }
  };
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// NEW: Universal proxy that accepts provider key directly
app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const { model, messages, stream, ...rest } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ error: 'model and messages are required' });
  }
  
  // Get provider key from Authorization header directly
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Missing Authorization header',
      message: 'Pass your provider API key (OpenAI, Anthropic, etc.) in the Authorization header'
    });
  }
  
  const providerKey = authHeader.replace('Bearer ', '');
  
  // Detect provider from key or model
  let provider = detectProviderFromKey(providerKey);
  if (!provider) {
    provider = detectProviderFromModel(model);
  }
  
  // Hash key and get/create account
  const keyHash = hashKey(providerKey);
  const account = getOrCreateAccount(keyHash, provider);
  
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const promptText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  
  // Store original request for replay capability
  const originalRequest = JSON.stringify({ model, messages, ...rest });
  
  // Log as running
  db.prepare(`
    INSERT INTO tasks (
      id, account_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      model, prompt, trace_id, started_at, original_request
    )
    VALUES (?, ?, 'proxy', ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    account.id,
    `Proxy: ${model}`,
    provider,
    JSON.stringify({ stream: !!stream, message_count: messages.length }),
    new Date().toISOString(),
    model,
    promptText,
    traceId,
    new Date().toISOString(),
    originalRequest
  );
  
  console.log(`[PROXY] ${provider}/${model} | Account ${account.id.substring(0, 8)}...`);
  
  try {
    let response;
    let responseData;
    let tokensIn = 0;
    let tokensOut = 0;
    let completionText = '';
    
    if (provider === 'anthropic') {
      const anthropicRequest = convertToAnthropic(req.body);
      
      if (stream) {
        response = await fetch(getProviderEndpoint(provider), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': providerKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(anthropicRequest)
        });
        
        if (!response.ok) throw new Error(`Anthropic error: ${response.status} - ${await response.text()}`);
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
              try {
                const event = JSON.parse(data);
                if (event.type === 'message_start') tokensIn = event.message?.usage?.input_tokens || 0;
                if (event.type === 'message_delta') tokensOut = event.usage?.output_tokens || 0;
                if (event.type === 'content_block_delta' && event.delta?.text) {
                  completionText += event.delta.text;
                  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-' + taskId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] })}\n\n`);
                }
                if (event.type === 'message_stop') {
                  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-' + taskId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                  res.write('data: [DONE]\n\n');
                }
              } catch (e) {}
            }
          }
        }
        res.end();
      } else {
        response = await fetch(getProviderEndpoint(provider), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': providerKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(anthropicRequest)
        });
        
        if (!response.ok) throw new Error(`Anthropic error: ${response.status} - ${await response.text()}`);
        
        const anthropicData = await response.json();
        responseData = convertFromAnthropic(anthropicData, model);
        tokensIn = responseData.usage.prompt_tokens;
        tokensOut = responseData.usage.completion_tokens;
        completionText = responseData.choices[0]?.message?.content || '';
        res.json(responseData);
      }
    } else if (provider === 'google') {
      const geminiRequest = convertToGemini(req.body);
      const url = `${getProviderEndpoint(provider)}/${model}:generateContent?key=${providerKey}`;
      
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiRequest) });
      if (!response.ok) throw new Error(`Gemini error: ${response.status} - ${await response.text()}`);
      
      const geminiData = await response.json();
      responseData = convertFromGemini(geminiData, model);
      tokensIn = responseData.usage.prompt_tokens;
      tokensOut = responseData.usage.completion_tokens;
      completionText = responseData.choices[0]?.message?.content || '';
      res.json(responseData);
    } else {
      // OpenAI, xAI, OpenRouter
      const endpoint = getProviderEndpoint(provider);
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${providerKey}` };
      
      if (stream) {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model, messages, stream: true, ...rest }) });
        if (!response.ok) throw new Error(`${provider} error: ${response.status} - ${await response.text()}`);
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              res.write(line + '\n\n');
              const data = line.slice(6);
              if (data !== '[DONE]') {
                try {
                  const chunk = JSON.parse(data);
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) completionText += delta;
                } catch (e) {}
              }
            }
          }
        }
        res.end();
        tokensIn = estimateTokens(promptText);
        tokensOut = estimateTokens(completionText);
      } else {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model, messages, stream: false, ...rest }) });
        if (!response.ok) throw new Error(`${provider} error: ${response.status} - ${await response.text()}`);
        
        responseData = await response.json();
        tokensIn = responseData.usage?.prompt_tokens || estimateTokens(promptText);
        tokensOut = responseData.usage?.completion_tokens || 0;
        completionText = responseData.choices?.[0]?.message?.content || '';
        res.json(responseData);
      }
    }
    
    // Update task with success
    const durationMs = Date.now() - startTime;
    const cost = calculateCost(model, tokensIn, tokensOut);
    
    db.prepare(`UPDATE tasks SET status = 'success', duration_ms = ?, cost = ?, completion = ?, tokens_in = ?, tokens_out = ?, completed_at = ? WHERE id = ?`)
      .run(durationMs, cost, completionText, tokensIn, tokensOut, new Date().toISOString(), taskId);
    
    console.log(`[PROXY] ✓ ${model} | ${durationMs}ms | ${tokensIn}+${tokensOut} tokens | $${cost.toFixed(4)}`);
    
  } catch (error) {
    const durationMs = Date.now() - startTime;
    db.prepare(`UPDATE tasks SET status = 'failed', duration_ms = ?, error = ?, completed_at = ? WHERE id = ?`)
      .run(durationMs, error.message, new Date().toISOString(), taskId);
    
    console.error(`[PROXY] ✗ ${model} | ${error.message}`);
    
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message, type: 'proxy_error', provider: provider } });
    }
  }
});

// List models endpoint
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_COSTS).map(id => ({
    id, object: 'model', created: 1700000000, owned_by: detectProviderFromModel(id)
  }));
  res.json({ object: 'list', data: models });
});

// ===== ANTHROPIC MESSAGES API PROXY (for Claude Code) =====

const ANTHROPIC_COSTS = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-7-sonnet-20250219': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet-20240620': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-sonnet-20240229': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
};

function calculateAnthropicCost(model, usage) {
  if (!usage) return 0;
  
  // Find matching cost entry (try exact match first, then prefix match)
  let costs = ANTHROPIC_COSTS[model];
  if (!costs) {
    const matchedKey = Object.keys(ANTHROPIC_COSTS).find(key => 
      model.includes(key) || key.includes(model.replace(/-\d{8}$/, ''))
    );
    costs = matchedKey ? ANTHROPIC_COSTS[matchedKey] : { input: 3, output: 15 }; // default to sonnet pricing
  }
  
  const inputCost = (usage.input_tokens || 0) / 1000000 * costs.input;
  const outputCost = (usage.output_tokens || 0) / 1000000 * costs.output;
  
  // Cache tokens are cheaper (90% discount for reads, 25% premium for writes)
  const cacheReadCost = (usage.cache_read_input_tokens || 0) / 1000000 * costs.input * 0.1;
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) / 1000000 * costs.input * 1.25;
  
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

function extractTaskDescription(messages) {
  if (!messages || messages.length === 0) return 'Claude Code task';
  
  // Get last user message as task description
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (lastUser) {
    // Handle both string and array content formats
    let content;
    if (typeof lastUser.content === 'string') {
      content = lastUser.content;
    } else if (Array.isArray(lastUser.content)) {
      // Find text content in array
      const textPart = lastUser.content.find(p => p.type === 'text');
      content = textPart?.text || '';
    } else {
      content = '';
    }
    
    // Clean and truncate
    const cleaned = content.replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, 100) || 'Claude Code task';
  }
  return 'Claude Code task';
}

// POST /v1/messages - Anthropic Messages API proxy
app.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const { model, messages, system, stream, max_tokens, ...rest } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ 
      type: 'error',
      error: { type: 'invalid_request_error', message: 'model and messages are required' }
    });
  }
  
  // Get API key from x-api-key header (Anthropic style) or Authorization header
  let apiKey = req.headers['x-api-key'];
  if (!apiKey && req.headers.authorization) {
    apiKey = req.headers.authorization.replace('Bearer ', '');
  }
  
  if (!apiKey) {
    return res.status(401).json({ 
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing API key. Use x-api-key header.' }
    });
  }
  
  // Hash key and get/create account
  const keyHash = hashKey(apiKey);
  const account = getOrCreateAccount(keyHash, 'anthropic');
  
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const taskDescription = extractTaskDescription(messages);
  const promptText = messages.map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${content}`;
  }).join('\n');
  
  // Store original request for replay
  const originalRequest = JSON.stringify(req.body);
  
  // Log as running
  db.prepare(`
    INSERT INTO tasks (
      id, account_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      model, prompt, trace_id, started_at, original_request
    )
    VALUES (?, ?, 'Claude Code', ?, 'running', 0, 0, 'anthropic', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    account.id,
    taskDescription,
    JSON.stringify({ stream: !!stream, message_count: messages.length, has_system: !!system }),
    new Date().toISOString(),
    model,
    promptText.substring(0, 50000), // Limit prompt storage
    traceId,
    new Date().toISOString(),
    originalRequest
  );
  
  console.log(`[ANTHROPIC] ${model} | Account ${account.id.substring(0, 8)}... | ${taskDescription.substring(0, 50)}`);
  
  // Forward to Anthropic
  const anthropicUrl = 'https://api.anthropic.com/v1/messages';
  
  // Build headers - forward Anthropic-specific headers
  const forwardHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  
  // Forward beta headers if present
  if (req.headers['anthropic-beta']) {
    forwardHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
  }
  
  try {
    if (stream) {
      // ===== STREAMING =====
      const response = await fetch(anthropicUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(req.body),
      });
      
      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[ANTHROPIC] ✗ ${response.status}: ${errorBody}`);
        
        // Update task as failed
        db.prepare(`UPDATE tasks SET status = 'failed', duration_ms = ?, error = ?, completed_at = ? WHERE id = ?`)
          .run(Date.now() - startTime, `HTTP ${response.status}: ${errorBody.substring(0, 500)}`, new Date().toISOString(), taskId);
        
        res.status(response.status).set('Content-Type', 'application/json').send(errorBody);
        return;
      }
      
      // Set up SSE response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let fullCompletion = '';
      let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let messageId = null;
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            // Forward the raw line to client
            if (line.trim()) {
              res.write(line + '\n');
            } else {
              res.write('\n');
            }
            
            // Parse event data for tracking
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data.trim() && data !== '[DONE]') {
                try {
                  const event = JSON.parse(data);
                  
                  // message_start: capture message ID and initial usage
                  if (event.type === 'message_start' && event.message) {
                    messageId = event.message.id;
                    if (event.message.usage) {
                      usage.input_tokens = event.message.usage.input_tokens || 0;
                      usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                      usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                    }
                  }
                  
                  // content_block_delta: capture text
                  if (event.type === 'content_block_delta' && event.delta?.text) {
                    fullCompletion += event.delta.text;
                  }
                  
                  // message_delta: capture final usage
                  if (event.type === 'message_delta' && event.usage) {
                    usage.output_tokens = event.usage.output_tokens || 0;
                  }
                  
                } catch (e) {
                  // Ignore parse errors for non-JSON lines
                }
              }
            }
          }
        }
        
        // Flush any remaining buffer
        if (buffer.trim()) {
          res.write(buffer + '\n');
        }
        
      } catch (streamError) {
        console.error(`[ANTHROPIC] Stream error: ${streamError.message}`);
      }
      
      res.end();
      
      // Update task with success
      const durationMs = Date.now() - startTime;
      const cost = calculateAnthropicCost(model, usage);
      
      db.prepare(`
        UPDATE tasks SET 
          status = 'success', duration_ms = ?, cost = ?, 
          completion = ?, tokens_in = ?, tokens_out = ?, completed_at = ?
        WHERE id = ?
      `).run(
        durationMs, 
        cost, 
        fullCompletion.substring(0, 50000), // Limit completion storage
        usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        usage.output_tokens,
        new Date().toISOString(),
        taskId
      );
      
      console.log(`[ANTHROPIC] ✓ ${model} | ${durationMs}ms | ${usage.input_tokens}+${usage.output_tokens} tokens | $${cost.toFixed(4)}`);
      
    } else {
      // ===== NON-STREAMING =====
      const response = await fetch(anthropicUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(req.body),
      });
      
      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[ANTHROPIC] ✗ ${response.status}: ${errorBody}`);
        
        db.prepare(`UPDATE tasks SET status = 'failed', duration_ms = ?, error = ?, completed_at = ? WHERE id = ?`)
          .run(Date.now() - startTime, `HTTP ${response.status}: ${errorBody.substring(0, 500)}`, new Date().toISOString(), taskId);
        
        res.status(response.status).set('Content-Type', 'application/json').send(errorBody);
        return;
      }
      
      const data = await response.json();
      
      // Extract completion text
      const completionText = data.content?.[0]?.text || '';
      
      // Calculate usage and cost
      const usage = data.usage || {};
      const durationMs = Date.now() - startTime;
      const cost = calculateAnthropicCost(model, usage);
      
      // Update task with success
      db.prepare(`
        UPDATE tasks SET 
          status = 'success', duration_ms = ?, cost = ?, 
          completion = ?, tokens_in = ?, tokens_out = ?, completed_at = ?
        WHERE id = ?
      `).run(
        durationMs,
        cost,
        completionText.substring(0, 50000),
        (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        usage.output_tokens || 0,
        new Date().toISOString(),
        taskId
      );
      
      console.log(`[ANTHROPIC] ✓ ${model} | ${durationMs}ms | ${usage.input_tokens || 0}+${usage.output_tokens || 0} tokens | $${cost.toFixed(4)}`);
      
      // Return original response
      res.json(data);
    }
    
  } catch (error) {
    const durationMs = Date.now() - startTime;
    
    db.prepare(`UPDATE tasks SET status = 'failed', duration_ms = ?, error = ?, completed_at = ? WHERE id = ?`)
      .run(durationMs, error.message, new Date().toISOString(), taskId);
    
    console.error(`[ANTHROPIC] ✗ ${model} | ${error.message}`);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        type: 'error',
        error: { 
          type: 'api_error', 
          message: error.message 
        }
      });
    }
  }
});

// ===== PROMPT ANALYSIS =====
app.post('/api/tasks/:id/analyze', validateApiKey, async (req, res) => {
  const accountId = getAccountId(req);
  
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND (api_key_id = ? OR account_id = ?)
  `).get(req.params.id, req.apiKey?.id || null, accountId);
  
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  if (!task.prompt) {
    return res.status(400).json({ error: 'Task has no prompt to analyze' });
  }
  
  // Get API key for analysis - use the user's provider key or a passed key
  const analysisKey = req.headers['x-analysis-key'] || req.providerKey;
  
  if (!analysisKey) {
    return res.json({
      quality_score: null,
      issues: [],
      improved_prompt: null,
      message: 'No API key available for analysis. Pass your OpenAI/Anthropic key in x-analysis-key header.'
    });
  }
  
  // Determine provider from key
  const provider = detectProviderFromKey(analysisKey);
  
  const analysisPrompt = `Analyze this AI prompt and provide feedback on how to make it more effective.

PROMPT TO ANALYZE:
"""
${task.prompt.substring(0, 2000)}
"""

Respond with a JSON object in this exact format (no markdown, just JSON):
{
  "quality_score": <number 0-100>,
  "issues": [
    {
      "type": "<vague|missing_context|too_long|unclear_goal|no_examples|ambiguous>",
      "description": "<brief description of the issue>",
      "suggestion": "<specific suggestion to fix it>"
    }
  ],
  "improved_prompt": "<a rewritten version of the prompt that addresses the issues>"
}

Be constructive and specific. Focus on 2-4 most important issues.`;

  try {
    let response;
    let analysisResult;
    
    if (provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': analysisKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1024,
          messages: [{ role: 'user', content: analysisPrompt }]
        })
      });
      
      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }
      
      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      analysisResult = JSON.parse(text);
    } else {
      // Default to OpenAI
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${analysisKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: analysisPrompt }],
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }
      
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';
      analysisResult = JSON.parse(text);
    }
    
    res.json({
      quality_score: analysisResult.quality_score || 50,
      issues: analysisResult.issues || [],
      improved_prompt: analysisResult.improved_prompt || null,
      analyzed_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[ANALYZE] Error:', error.message);
    res.status(500).json({ 
      error: 'Analysis failed', 
      message: error.message 
    });
  }
});

// ===== REPLAY TASK =====
app.post('/api/tasks/:id/replay', validateApiKey, async (req, res) => {
  const accountId = getAccountId(req);
  
  const originalTask = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND (api_key_id = ? OR account_id = ?)
  `).get(req.params.id, req.apiKey?.id || null, accountId);
  
  if (!originalTask) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  // Parse original_request if available, or reconstruct from task data
  let originalRequest = null;
  if (originalTask.original_request) {
    try {
      originalRequest = JSON.parse(originalTask.original_request);
    } catch (e) {}
  }
  
  // If no original request stored, try to reconstruct from prompt/model
  if (!originalRequest && originalTask.prompt && originalTask.model) {
    // Try to parse the prompt back into messages format
    const promptLines = originalTask.prompt.split('\n');
    const messages = [];
    let currentRole = 'user';
    let currentContent = [];
    
    for (const line of promptLines) {
      if (line.startsWith('system:')) {
        if (currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
          currentContent = [];
        }
        currentRole = 'system';
        currentContent.push(line.replace('system:', '').trim());
      } else if (line.startsWith('user:')) {
        if (currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
          currentContent = [];
        }
        currentRole = 'user';
        currentContent.push(line.replace('user:', '').trim());
      } else if (line.startsWith('assistant:')) {
        if (currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
          currentContent = [];
        }
        currentRole = 'assistant';
        currentContent.push(line.replace('assistant:', '').trim());
      } else {
        currentContent.push(line);
      }
    }
    
    if (currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
    }
    
    // If we couldn't parse roles, just use the whole thing as user message
    if (messages.length === 0) {
      messages.push({ role: 'user', content: originalTask.prompt });
    }
    
    originalRequest = {
      model: originalTask.model,
      messages: messages
    };
  }
  
  if (!originalRequest) {
    return res.status(400).json({ 
      error: 'Cannot replay task', 
      message: 'No original request data available' 
    });
  }
  
  // Get provider key for replay
  const providerKey = req.providerKey || req.headers['x-provider-key'];
  
  if (!providerKey) {
    return res.status(400).json({
      error: 'No provider key',
      message: 'Pass your API key in Authorization header or x-provider-key header'
    });
  }
  
  // Create new task linked to original
  const replayId = crypto.randomUUID();
  const replayTraceId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, account_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      model, prompt, trace_id, parent_id, span_name, started_at, original_request
    )
    VALUES (?, ?, ?, ?, ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?, 'replay', ?, ?)
  `).run(
    replayId,
    req.apiKey?.id || null,
    accountId,
    originalTask.agent_name,
    `[REPLAY] ${originalTask.description}`,
    originalTask.provider,
    JSON.stringify({ original_task_id: originalTask.id, replay: true }),
    now,
    originalTask.model,
    originalTask.prompt,
    replayTraceId,
    originalTask.id,
    now,
    JSON.stringify(originalRequest)
  );
  
  console.log(`[REPLAY] Starting replay of task ${originalTask.id} -> ${replayId}`);
  
  // Execute the request through our proxy logic
  const startTime = Date.now();
  const provider = detectProviderFromKey(providerKey) || detectProviderFromModel(originalRequest.model);
  
  try {
    let response;
    let tokensIn = 0;
    let tokensOut = 0;
    let completionText = '';
    
    if (provider === 'anthropic') {
      const anthropicRequest = convertToAnthropic(originalRequest);
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': providerKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(anthropicRequest)
      });
      
      if (!response.ok) {
        throw new Error(`Anthropic error: ${response.status} - ${await response.text()}`);
      }
      
      const anthropicData = await response.json();
      tokensIn = anthropicData.usage?.input_tokens || 0;
      tokensOut = anthropicData.usage?.output_tokens || 0;
      completionText = anthropicData.content?.[0]?.text || '';
    } else if (provider === 'google') {
      const geminiRequest = convertToGemini(originalRequest);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${originalRequest.model}:generateContent?key=${providerKey}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest)
      });
      
      if (!response.ok) {
        throw new Error(`Gemini error: ${response.status} - ${await response.text()}`);
      }
      
      const geminiData = await response.json();
      tokensIn = geminiData.usageMetadata?.promptTokenCount || 0;
      tokensOut = geminiData.usageMetadata?.candidatesTokenCount || 0;
      completionText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      // OpenAI / xAI / OpenRouter
      const endpoint = getProviderEndpoint(provider);
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerKey}`
        },
        body: JSON.stringify(originalRequest)
      });
      
      if (!response.ok) {
        throw new Error(`${provider} error: ${response.status} - ${await response.text()}`);
      }
      
      const data = await response.json();
      tokensIn = data.usage?.prompt_tokens || 0;
      tokensOut = data.usage?.completion_tokens || 0;
      completionText = data.choices?.[0]?.message?.content || '';
    }
    
    const durationMs = Date.now() - startTime;
    const cost = calculateCost(originalRequest.model, tokensIn, tokensOut);
    
    // Update task with success
    db.prepare(`
      UPDATE tasks SET 
        status = 'success', duration_ms = ?, cost = ?, 
        completion = ?, tokens_in = ?, tokens_out = ?, completed_at = ?
      WHERE id = ?
    `).run(durationMs, cost, completionText, tokensIn, tokensOut, new Date().toISOString(), replayId);
    
    console.log(`[REPLAY] ✓ ${originalRequest.model} | ${durationMs}ms | $${cost.toFixed(4)}`);
    
    res.json({
      success: true,
      replay_task_id: replayId,
      original_task_id: originalTask.id,
      status: 'success',
      duration_ms: durationMs,
      cost: cost,
      completion: completionText
    });
    
  } catch (error) {
    const durationMs = Date.now() - startTime;
    
    db.prepare(`
      UPDATE tasks SET status = 'failed', duration_ms = ?, error = ?, completed_at = ?
      WHERE id = ?
    `).run(durationMs, error.message, new Date().toISOString(), replayId);
    
    console.error(`[REPLAY] ✗ ${error.message}`);
    
    res.status(500).json({
      success: false,
      replay_task_id: replayId,
      original_task_id: originalTask.id,
      status: 'failed',
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgentLog API v2.1 running on port ${PORT}`);
  console.log(`Proxy endpoints:`);
  console.log(`  POST /v1/chat/completions - OpenAI-compatible (use your provider key)`);
  console.log(`  POST /v1/messages - Anthropic Messages API (for Claude Code)`);
  console.log(`Account lookup: POST /api/account/lookup`);
  console.log(`Analysis: POST /api/tasks/:id/analyze`);
  console.log(`Replay: POST /api/tasks/:id/replay`);
});

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
  
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
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
    -- NEW: Full request/response logging
    model TEXT,
    prompt TEXT,
    completion TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    -- NEW: Trace support (parent-child relationships)
    trace_id TEXT,
    parent_id TEXT,
    span_name TEXT,
    -- NEW: Prompt versioning
    prompt_version TEXT,
    prompt_template_id TEXT
  );
  
  -- Prompt templates for versioning
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    name TEXT NOT NULL,
    template TEXT NOT NULL,
    variables TEXT DEFAULT '[]',
    version INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metrics TEXT DEFAULT '{}'
  );
  
  CREATE INDEX IF NOT EXISTS idx_tasks_api_key ON tasks(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_trace_id ON tasks(trace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_templates_api_key ON prompt_templates(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_running ON tasks(status) WHERE status IN ('pending', 'running');
`);

// Create default API key if none exists
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

// Middleware to validate API key
const validateApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  
  const key = authHeader.replace('Bearer ', '');
  const apiKey = db.prepare('SELECT * FROM api_keys WHERE key = ?').get(key);
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  // Update last_used_at
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    apiKey.id
  );
  
  req.apiKey = apiKey;
  next();
};

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'AgentLog API',
    version: '1.0.0'
  });
});

// Get API key info
app.get('/api/key', (req, res) => {
  const apiKey = db.prepare('SELECT key, name FROM api_keys LIMIT 1').get();
  res.json(apiKey);
});

// Track a task (with full request/response support)
app.post('/api/track', validateApiKey, (req, res) => {
  const { 
    agent, task, status, durationMs, cost, error, provider, metadata,
    // NEW: Full request/response
    model, prompt, completion, tokens_in, tokens_out,
    // NEW: Trace support
    trace_id, parent_id, span_name,
    // NEW: Prompt versioning
    prompt_version, prompt_template_id
  } = req.body;
  
  // Validate required fields
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
  const generatedTraceId = trace_id || crypto.randomUUID(); // Auto-generate trace_id if not provided
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, agent_name, description, status, duration_ms, cost, error, provider, metadata, created_at,
      model, prompt, completion, tokens_in, tokens_out,
      trace_id, parent_id, span_name,
      prompt_version, prompt_template_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.apiKey.id,
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
  
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      trace_id, parent_id, span_name, started_at
    )
    VALUES (?, ?, ?, ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.apiKey.id,
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
  
  const result = db.prepare(`
    UPDATE tasks SET 
      status = ?, duration_ms = ?, cost = ?, error = ?,
      model = ?, prompt = ?, completion = ?, tokens_in = ?, tokens_out = ?,
      metadata = ?, completed_at = ?
    WHERE id = ? AND api_key_id = ? AND status = 'running'
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
    req.apiKey.id
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
  
  const tasks = db.prepare(`
    SELECT * FROM tasks 
    WHERE api_key_id = ? AND created_at > ?
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.apiKey.id, since, limit);
  
  res.json(tasks);
});

// Get single task with full details
app.get('/api/tasks/:id', validateApiKey, (req, res) => {
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND api_key_id = ?
  `).get(req.params.id, req.apiKey.id);
  
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  res.json(task);
});

// ===== TRACES =====
// Get all traces (grouped by trace_id)
app.get('/api/traces', validateApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  // Get unique traces with summary info
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
    WHERE api_key_id = ? AND created_at > ? AND trace_id IS NOT NULL
    GROUP BY trace_id
    ORDER BY started_at DESC
    LIMIT ?
  `).all(req.apiKey.id, since, limit);
  
  res.json(traces);
});

// Get single trace with full tree structure
app.get('/api/traces/:traceId', validateApiKey, (req, res) => {
  const spans = db.prepare(`
    SELECT * FROM tasks 
    WHERE trace_id = ? AND api_key_id = ?
    ORDER BY created_at ASC
  `).all(req.params.traceId, req.apiKey.id);
  
  if (spans.length === 0) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  
  // Build tree structure
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
  
  // Calculate trace summary
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
// Create/update prompt template
app.post('/api/prompts', validateApiKey, (req, res) => {
  const { name, template, variables } = req.body;
  
  if (!name || !template) {
    return res.status(400).json({ error: 'name and template are required' });
  }
  
  // Check if prompt with this name exists
  const existing = db.prepare(`
    SELECT * FROM prompt_templates WHERE api_key_id = ? AND name = ? AND is_active = 1
  `).get(req.apiKey.id, name);
  
  const id = crypto.randomUUID();
  const version = existing ? existing.version + 1 : 1;
  
  // Deactivate old version
  if (existing) {
    db.prepare(`UPDATE prompt_templates SET is_active = 0 WHERE id = ?`).run(existing.id);
  }
  
  // Create new version
  db.prepare(`
    INSERT INTO prompt_templates (id, api_key_id, name, template, variables, version, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    req.apiKey.id,
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

// Get all prompt templates
app.get('/api/prompts', validateApiKey, (req, res) => {
  const includeInactive = req.query.all === 'true';
  
  const prompts = db.prepare(`
    SELECT * FROM prompt_templates 
    WHERE api_key_id = ? ${includeInactive ? '' : 'AND is_active = 1'}
    ORDER BY name, version DESC
  `).all(req.apiKey.id);
  
  res.json(prompts);
});

// Get prompt template by name (with version history)
app.get('/api/prompts/:name', validateApiKey, (req, res) => {
  const versions = db.prepare(`
    SELECT * FROM prompt_templates 
    WHERE api_key_id = ? AND name = ?
    ORDER BY version DESC
  `).all(req.apiKey.id, req.params.name);
  
  if (versions.length === 0) {
    return res.status(404).json({ error: 'Prompt template not found' });
  }
  
  // Get performance metrics for each version
  const versionsWithMetrics = versions.map(v => {
    const metrics = db.prepare(`
      SELECT 
        COUNT(*) as usage_count,
        AVG(duration_ms) as avg_duration,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
        SUM(cost) as total_cost
      FROM tasks
      WHERE api_key_id = ? AND prompt_template_id = ?
    `).get(req.apiKey.id, v.id);
    
    return { ...v, metrics };
  });
  
  res.json({
    name: req.params.name,
    current_version: versions[0].version,
    versions: versionsWithMetrics
  });
});

// Compare two prompt versions
app.get('/api/prompts/:name/compare', validateApiKey, (req, res) => {
  const { v1, v2 } = req.query;
  
  if (!v1 || !v2) {
    return res.status(400).json({ error: 'v1 and v2 query params required' });
  }
  
  const getVersionMetrics = (version) => {
    const prompt = db.prepare(`
      SELECT * FROM prompt_templates 
      WHERE api_key_id = ? AND name = ? AND version = ?
    `).get(req.apiKey.id, req.params.name, version);
    
    if (!prompt) return null;
    
    const metrics = db.prepare(`
      SELECT 
        COUNT(*) as usage_count,
        AVG(duration_ms) as avg_duration_ms,
        AVG(tokens_in + tokens_out) as avg_tokens,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
        SUM(cost) as total_cost,
        AVG(cost) as avg_cost
      FROM tasks
      WHERE api_key_id = ? AND prompt_template_id = ?
    `).get(req.apiKey.id, prompt.id);
    
    return { ...prompt, metrics };
  };
  
  const version1 = getVersionMetrics(parseInt(v1));
  const version2 = getVersionMetrics(parseInt(v2));
  
  if (!version1 || !version2) {
    return res.status(404).json({ error: 'One or both versions not found' });
  }
  
  res.json({
    name: req.params.name,
    comparison: {
      v1: version1,
      v2: version2,
      diff: {
        success_rate: (version2.metrics.success_rate || 0) - (version1.metrics.success_rate || 0),
        avg_duration_ms: (version2.metrics.avg_duration_ms || 0) - (version1.metrics.avg_duration_ms || 0),
        avg_cost: (version2.metrics.avg_cost || 0) - (version1.metrics.avg_cost || 0)
      }
    }
  });
});

// Get health metrics
app.get('/api/health', validateApiKey, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
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
    WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, since);
  
  res.json(stats);
});

// Get failure patterns
app.get('/api/failures', validateApiKey, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  const patterns = db.prepare(`
    SELECT 
      COALESCE(error, 'Unknown error') as error_type,
      COUNT(*) as count,
      GROUP_CONCAT(description, ', ') as examples
    FROM tasks
    WHERE api_key_id = ? AND created_at > ? AND status = 'failed'
    GROUP BY error_type
    ORDER BY count DESC
    LIMIT 10
  `).all(req.apiKey.id, since);
  
  res.json(patterns);
});

// Smart Alerts - Pattern-based alert detection
app.get('/api/alerts', validateApiKey, (req, res) => {
  const alerts = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
  
  // 1. Failure spike detection
  const hourlyStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      COUNT(*) as total
    FROM tasks
    WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, oneHourAgo);
  
  const dailyStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      COUNT(*) as total
    FROM tasks
    WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, oneDayAgo);
  
  const hourlyFailRate = hourlyStats.total > 0 ? hourlyStats.failed / hourlyStats.total : 0;
  const dailyFailRate = dailyStats.total > 0 ? dailyStats.failed / dailyStats.total : 0;
  
  if (hourlyFailRate > 0 && hourlyFailRate > dailyFailRate * 2) {
    alerts.push({
      type: 'failure_spike',
      severity: 'high',
      title: 'Failure Rate Spike',
      message: `Failure rate in the last hour (${(hourlyFailRate * 100).toFixed(0)}%) is ${(hourlyFailRate / dailyFailRate).toFixed(1)}x higher than daily average`,
      metric: { hourly: hourlyFailRate, daily: dailyFailRate }
    });
  }
  
  // 2. Cost anomaly detection
  const hourlyCost = db.prepare(`
    SELECT SUM(cost) as total FROM tasks WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, oneHourAgo);
  
  const avgHourlyCost = db.prepare(`
    SELECT AVG(cost) * 24 / 24 as avg FROM tasks WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, oneDayAgo);
  
  if (hourlyCost.total > 0 && avgHourlyCost.avg > 0 && hourlyCost.total > avgHourlyCost.avg * 3) {
    alerts.push({
      type: 'cost_anomaly',
      severity: 'medium',
      title: 'Cost Spike Detected',
      message: `Spent $${hourlyCost.total.toFixed(2)} in the last hour, ${(hourlyCost.total / avgHourlyCost.avg).toFixed(1)}x above average`,
      metric: { current: hourlyCost.total, average: avgHourlyCost.avg }
    });
  }
  
  // 3. Latency trend detection
  const recentLatency = db.prepare(`
    SELECT AVG(duration_ms) as avg FROM tasks WHERE api_key_id = ? AND created_at > ?
  `).get(req.apiKey.id, oneHourAgo);
  
  const baselineLatency = db.prepare(`
    SELECT AVG(duration_ms) as avg FROM tasks WHERE api_key_id = ? AND created_at > ? AND created_at < ?
  `).get(req.apiKey.id, threeHoursAgo, oneHourAgo);
  
  if (recentLatency.avg > 0 && baselineLatency.avg > 0 && recentLatency.avg > baselineLatency.avg * 1.5) {
    alerts.push({
      type: 'latency_trend',
      severity: 'low',
      title: 'Latency Increasing',
      message: `Average latency (${(recentLatency.avg / 1000).toFixed(1)}s) is ${((recentLatency.avg / baselineLatency.avg - 1) * 100).toFixed(0)}% higher than baseline`,
      metric: { current: recentLatency.avg, baseline: baselineLatency.avg }
    });
  }
  
  res.json({ alerts, timestamp: now.toISOString() });
});

// Failure Clustering - Group similar errors
app.get('/api/clusters', validateApiKey, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  const failures = db.prepare(`
    SELECT id, description, error, created_at, agent_name, cost
    FROM tasks
    WHERE api_key_id = ? AND created_at > ? AND status = 'failed'
    ORDER BY created_at DESC
  `).all(req.apiKey.id, since);
  
  // Group by error message prefix (first 50 chars)
  const clusters = {};
  for (const failure of failures) {
    const key = (failure.error || 'Unknown error').substring(0, 50);
    if (!clusters[key]) {
      clusters[key] = {
        cluster_name: key,
        count: 0,
        total_cost: 0,
        examples: [],
        agents: new Set(),
        first_seen: failure.created_at,
        last_seen: failure.created_at
      };
    }
    clusters[key].count++;
    clusters[key].total_cost += failure.cost || 0;
    clusters[key].agents.add(failure.agent_name);
    if (clusters[key].examples.length < 3) {
      clusters[key].examples.push(failure.description);
    }
    if (failure.created_at < clusters[key].first_seen) {
      clusters[key].first_seen = failure.created_at;
    }
    if (failure.created_at > clusters[key].last_seen) {
      clusters[key].last_seen = failure.created_at;
    }
  }
  
  // Convert to array and format
  const result = Object.values(clusters)
    .map(c => ({
      ...c,
      agents: Array.from(c.agents),
      total_cost: c.total_cost.toFixed(4)
    }))
    .sort((a, b) => b.count - a.count);
  
  res.json(result);
});

// ===== QUALITY SCORING & SUGGESTIONS =====

// Simple heuristic-based quality scoring (could be replaced with LLM-based eval)
const scoreCompletion = (task) => {
  if (!task.completion) return null;
  
  const prompt = task.prompt || '';
  const completion = task.completion || '';
  
  let scores = {
    relevance: 0,
    conciseness: 0,
    completeness: 0,
    overall: 0
  };
  
  // Relevance: Does completion mention key terms from prompt?
  const promptWords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const completionLower = completion.toLowerCase();
  const matchedWords = promptWords.filter(w => completionLower.includes(w));
  scores.relevance = Math.min(100, Math.round((matchedWords.length / Math.max(promptWords.length, 1)) * 100 + 40));
  
  // Conciseness: Penalize very long or very short responses
  const completionLength = completion.length;
  const promptLength = prompt.length;
  const ratio = completionLength / Math.max(promptLength, 1);
  if (ratio < 0.5) scores.conciseness = 60; // Too short
  else if (ratio > 10) scores.conciseness = 50; // Way too long
  else if (ratio > 5) scores.conciseness = 70; // A bit long
  else scores.conciseness = 90; // Good ratio
  
  // Completeness: Check for incomplete sentences, hedging
  const hasIncomplete = completion.endsWith('...') || completion.includes('I cannot') || completion.includes("I'm not sure");
  scores.completeness = hasIncomplete ? 60 : 85;
  
  // Boost for structured responses
  if (completion.includes('\n') || completion.includes('1.') || completion.includes('•')) {
    scores.completeness = Math.min(100, scores.completeness + 10);
  }
  
  // Overall weighted score
  scores.overall = Math.round(scores.relevance * 0.4 + scores.conciseness * 0.3 + scores.completeness * 0.3);
  
  return scores;
};

// Generate improvement suggestions
const generateSuggestions = (task) => {
  const suggestions = [];
  const prompt = task.prompt || '';
  const completion = task.completion || '';
  const error = task.error || '';
  
  // Error-based suggestions
  if (task.status === 'failed') {
    if (error.toLowerCase().includes('timeout')) {
      suggestions.push({
        type: 'error_fix',
        priority: 'high',
        title: 'Reduce context size',
        description: 'Timeout errors often mean the context is too large. Try summarizing or chunking your input.',
        icon: '⏱️'
      });
    }
    if (error.toLowerCase().includes('rate limit')) {
      suggestions.push({
        type: 'error_fix',
        priority: 'high', 
        title: 'Add retry with backoff',
        description: 'Implement exponential backoff: wait 1s, then 2s, then 4s between retries.',
        icon: '🔄'
      });
    }
    if (error.toLowerCase().includes('context length') || error.toLowerCase().includes('too long')) {
      suggestions.push({
        type: 'error_fix',
        priority: 'high',
        title: 'Reduce prompt length',
        description: 'Your prompt exceeds the model limit. Remove unnecessary context or use a model with larger context.',
        icon: '✂️'
      });
    }
  }
  
  // Prompt quality suggestions
  if (prompt.length < 50) {
    suggestions.push({
      type: 'prompt_improvement',
      priority: 'medium',
      title: 'Add more context',
      description: 'Short prompts often lead to vague responses. Add specific details about what you need.',
      icon: '📝'
    });
  }
  
  if (!prompt.includes('example') && !prompt.includes('e.g.') && !prompt.includes('for instance')) {
    suggestions.push({
      type: 'prompt_improvement',
      priority: 'medium',
      title: 'Add examples (few-shot)',
      description: 'Including 1-2 examples of desired output can improve accuracy by 20-40%.',
      icon: '💡'
    });
  }
  
  if (prompt.toLowerCase().includes('please') || prompt.toLowerCase().includes('could you')) {
    suggestions.push({
      type: 'prompt_improvement',
      priority: 'low',
      title: 'Be more direct',
      description: 'Polite phrases waste tokens. Instead of "Could you please summarize", just say "Summarize:"',
      icon: '🎯'
    });
  }
  
  // Response quality suggestions
  if (completion && completion.length > 2000) {
    suggestions.push({
      type: 'response_optimization',
      priority: 'medium',
      title: 'Request concise output',
      description: 'Add "Be concise" or "Respond in under 100 words" to reduce token usage and cost.',
      icon: '💰'
    });
  }
  
  // Slow task suggestions
  if (task.status === 'slow' || task.duration_ms > 10000) {
    suggestions.push({
      type: 'performance',
      priority: 'medium',
      title: 'Consider streaming',
      description: 'For long responses, use streaming to show partial results and improve perceived speed.',
      icon: '⚡'
    });
  }
  
  return suggestions;
};

// Endpoint: Get task with quality score and suggestions
app.get('/api/tasks/:id/evaluate', validateApiKey, (req, res) => {
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND api_key_id = ?
  `).get(req.params.id, req.apiKey.id);
  
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

// Endpoint: Retry a failed task (creates a new task linked to original)
app.post('/api/tasks/:id/retry', validateApiKey, (req, res) => {
  const originalTask = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND api_key_id = ?
  `).get(req.params.id, req.apiKey.id);
  
  if (!originalTask) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  // For now, just create a placeholder - in production this would actually call the LLM
  const { modified_prompt } = req.body;
  
  const retryId = crypto.randomUUID();
  const retryTraceId = crypto.randomUUID();
  
  // Create retry record
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, agent_name, description, status, duration_ms, cost, error, provider, metadata, created_at,
      model, prompt, completion, tokens_in, tokens_out, trace_id, parent_id, span_name
    )
    VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, 'retry')
  `).run(
    retryId,
    req.apiKey.id,
    originalTask.agent_name,
    `[RETRY] ${originalTask.description}`,
    originalTask.provider,
    JSON.stringify({ 
      original_task_id: originalTask.id,
      retry_reason: 'manual_retry',
      modified_prompt: !!modified_prompt
    }),
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
    message: 'Retry task created. In production, this would execute the LLM call.',
    prompt_used: modified_prompt || originalTask.prompt
  });
});

// Endpoint: Get improvement suggestion for a prompt
app.post('/api/improve-prompt', validateApiKey, (req, res) => {
  const { prompt, context } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  
  // Simple rule-based improvements (could be LLM-powered in production)
  let improved = prompt;
  const changes = [];
  
  // Remove filler words
  const fillers = ['please', 'could you', 'would you', 'can you', 'I need you to'];
  fillers.forEach(filler => {
    if (improved.toLowerCase().includes(filler)) {
      improved = improved.replace(new RegExp(filler, 'gi'), '').trim();
      changes.push(`Removed "${filler}" - be direct to save tokens`);
    }
  });
  
  // Add structure if missing
  if (!improved.includes(':') && !improved.includes('\n')) {
    improved = improved + '\n\nProvide a clear, structured response.';
    changes.push('Added structure request for better output formatting');
  }
  
  // Suggest format if not specified
  if (!improved.toLowerCase().includes('format') && !improved.toLowerCase().includes('json') && !improved.toLowerCase().includes('list')) {
    changes.push('Consider specifying output format (JSON, bullet points, etc.)');
  }
  
  res.json({
    original: prompt,
    improved: improved.trim(),
    changes,
    estimated_improvement: changes.length > 0 ? `${changes.length * 10}% potential improvement` : 'Prompt looks good!'
  });
});

// ===== UNIVERSAL AI PROXY =====

// Model costs (USD per 1K tokens)
const MODEL_COSTS = {
  // OpenAI GPT-4
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-32k': { input: 0.06, output: 0.12 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  // OpenAI GPT-3.5
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-3.5-turbo-16k': { input: 0.003, output: 0.004 },
  // OpenAI o1
  'o1-preview': { input: 0.015, output: 0.06 },
  'o1-mini': { input: 0.003, output: 0.012 },
  'o1': { input: 0.015, output: 0.06 },
  // Anthropic Claude 3.5
  'claude-3-5-sonnet-20240620': { input: 0.003, output: 0.015 },
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-5-haiku-20241022': { input: 0.001, output: 0.005 },
  // Anthropic Claude 3
  'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
  'claude-3-sonnet-20240229': { input: 0.003, output: 0.015 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
  // Shorthand aliases
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  'claude-3.5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3.5-haiku': { input: 0.001, output: 0.005 },
  // Google Gemini
  'gemini-pro': { input: 0.00025, output: 0.0005 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  // xAI Grok
  'grok-beta': { input: 0.005, output: 0.015 },
  'grok-2': { input: 0.002, output: 0.01 },
};

// Calculate cost for tokens
function calculateCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    // Try partial match
    const matchedKey = Object.keys(MODEL_COSTS).find(key => 
      model.includes(key) || key.includes(model)
    );
    if (matchedKey) {
      const matchedCosts = MODEL_COSTS[matchedKey];
      return (inputTokens / 1000) * matchedCosts.input + (outputTokens / 1000) * matchedCosts.output;
    }
    return 0;
  }
  return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
}

// Detect provider from model name
function detectProvider(model) {
  if (!model) return 'openai';
  model = model.toLowerCase();
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.includes('openai')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('grok-')) return 'xai';
  if (model.includes('/')) return 'openrouter'; // format: provider/model
  return 'openai'; // default
}

// Get provider endpoint
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

// Convert OpenAI format to Anthropic format
function convertToAnthropic(openaiRequest) {
  const { model, messages, max_tokens, temperature, stream } = openaiRequest;
  
  // Extract system message
  const systemMessage = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  
  return {
    model: model,
    max_tokens: max_tokens || 4096,
    messages: otherMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    })),
    ...(systemMessage && { system: systemMessage.content }),
    ...(temperature !== undefined && { temperature }),
    stream: stream || false
  };
}

// Convert Anthropic response to OpenAI format
function convertFromAnthropic(anthropicResponse, model) {
  return {
    id: anthropicResponse.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: anthropicResponse.content?.[0]?.text || ''
      },
      finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop' : anthropicResponse.stop_reason
    }],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0)
    }
  };
}

// Convert OpenAI format to Google Gemini format
function convertToGemini(openaiRequest) {
  const { messages, max_tokens, temperature } = openaiRequest;
  
  // Extract system message
  const systemMessage = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  
  return {
    contents: otherMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    ...(systemMessage && {
      systemInstruction: { parts: [{ text: systemMessage.content }] }
    }),
    generationConfig: {
      ...(max_tokens && { maxOutputTokens: max_tokens }),
      ...(temperature !== undefined && { temperature })
    }
  };
}

// Convert Gemini response to OpenAI format
function convertFromGemini(geminiResponse, model) {
  const candidate = geminiResponse.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text || '';
  
  return {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : 'length'
    }],
    usage: {
      prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
    }
  };
}

// Estimate tokens (rough: ~4 chars per token)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Universal AI Proxy endpoint
app.post('/v1/chat/completions', validateApiKey, async (req, res) => {
  const startTime = Date.now();
  const { model, messages, stream, ...rest } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ error: 'model and messages are required' });
  }
  
  // Get provider API key from header or error
  const providerKey = req.headers['x-provider-key'];
  if (!providerKey) {
    return res.status(400).json({ 
      error: 'X-Provider-Key header is required',
      message: 'Pass your provider API key (OpenAI, Anthropic, etc.) in the X-Provider-Key header'
    });
  }
  
  const provider = detectProvider(model);
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const promptText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  
  // Log as running
  db.prepare(`
    INSERT INTO tasks (
      id, api_key_id, agent_name, description, status, duration_ms, cost, provider, metadata, created_at,
      model, prompt, trace_id, started_at
    )
    VALUES (?, ?, 'proxy', ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    req.apiKey.id,
    `Proxy: ${model}`,
    provider,
    JSON.stringify({ stream: !!stream, message_count: messages.length }),
    new Date().toISOString(),
    model,
    promptText,
    traceId,
    new Date().toISOString()
  );
  
  console.log(`[PROXY] ${provider}/${model} | Task ${taskId}`);
  
  try {
    let response;
    let responseData;
    let tokensIn = 0;
    let tokensOut = 0;
    let completionText = '';
    
    if (provider === 'anthropic') {
      // Convert and send to Anthropic
      const anthropicRequest = convertToAnthropic(req.body);
      
      if (stream) {
        // Streaming for Anthropic
        response = await fetch(getProviderEndpoint(provider), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': providerKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(anthropicRequest)
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Anthropic error: ${response.status} - ${error}`);
        }
        
        // Set up SSE streaming
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
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                continue;
              }
              
              try {
                const event = JSON.parse(data);
                
                // Track usage from Anthropic events
                if (event.type === 'message_start') {
                  tokensIn = event.message?.usage?.input_tokens || 0;
                }
                if (event.type === 'message_delta') {
                  tokensOut = event.usage?.output_tokens || 0;
                }
                if (event.type === 'content_block_delta' && event.delta?.text) {
                  completionText += event.delta.text;
                  
                  // Convert to OpenAI streaming format
                  const openaiChunk = {
                    id: 'chatcmpl-' + taskId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: event.delta.text },
                      finish_reason: null
                    }]
                  };
                  res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                }
                if (event.type === 'message_stop') {
                  const finalChunk = {
                    id: 'chatcmpl-' + taskId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop'
                    }]
                  };
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                }
              } catch (e) {
                // Skip malformed JSON
              }
            }
          }
        }
        
        res.end();
      } else {
        // Non-streaming Anthropic
        response = await fetch(getProviderEndpoint(provider), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': providerKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(anthropicRequest)
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Anthropic error: ${response.status} - ${error}`);
        }
        
        const anthropicData = await response.json();
        responseData = convertFromAnthropic(anthropicData, model);
        tokensIn = responseData.usage.prompt_tokens;
        tokensOut = responseData.usage.completion_tokens;
        completionText = responseData.choices[0]?.message?.content || '';
        
        res.json(responseData);
      }
    } else if (provider === 'google') {
      // Convert and send to Gemini
      const geminiRequest = convertToGemini(req.body);
      const geminiModel = model.includes(':') ? model : model;
      const url = `${getProviderEndpoint(provider)}/${geminiModel}:generateContent?key=${providerKey}`;
      
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest)
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini error: ${response.status} - ${error}`);
      }
      
      const geminiData = await response.json();
      responseData = convertFromGemini(geminiData, model);
      tokensIn = responseData.usage.prompt_tokens;
      tokensOut = responseData.usage.completion_tokens;
      completionText = responseData.choices[0]?.message?.content || '';
      
      res.json(responseData);
    } else {
      // OpenAI, xAI, OpenRouter - pass through directly
      const endpoint = getProviderEndpoint(provider);
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerKey}`
      };
      
      // Add OpenRouter specific headers if needed
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://agentlog.dev';
        headers['X-Title'] = 'AgentLog Proxy';
      }
      
      if (stream) {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, stream: true, ...rest })
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`${provider} error: ${response.status} - ${error}`);
        }
        
        // Stream through SSE
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
        
        // Estimate tokens for streaming (actual usage not available in stream)
        tokensIn = estimateTokens(promptText);
        tokensOut = estimateTokens(completionText);
      } else {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, stream: false, ...rest })
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`${provider} error: ${response.status} - ${error}`);
        }
        
        responseData = await response.json();
        tokensIn = responseData.usage?.prompt_tokens || estimateTokens(promptText);
        tokensOut = responseData.usage?.completion_tokens || 0;
        completionText = responseData.choices?.[0]?.message?.content || '';
        
        res.json(responseData);
      }
    }
    
    // Calculate cost and update task
    const durationMs = Date.now() - startTime;
    const cost = calculateCost(model, tokensIn, tokensOut);
    
    db.prepare(`
      UPDATE tasks SET 
        status = 'success',
        duration_ms = ?,
        cost = ?,
        completion = ?,
        tokens_in = ?,
        tokens_out = ?,
        completed_at = ?
      WHERE id = ?
    `).run(durationMs, cost, completionText, tokensIn, tokensOut, new Date().toISOString(), taskId);
    
    console.log(`[PROXY] ✓ ${model} | ${durationMs}ms | ${tokensIn}+${tokensOut} tokens | $${cost.toFixed(4)}`);
    
  } catch (error) {
    const durationMs = Date.now() - startTime;
    
    db.prepare(`
      UPDATE tasks SET 
        status = 'failed',
        duration_ms = ?,
        error = ?,
        completed_at = ?
      WHERE id = ?
    `).run(durationMs, error.message, new Date().toISOString(), taskId);
    
    console.error(`[PROXY] ✗ ${model} | ${error.message}`);
    
    // Only send error if headers not sent (non-streaming)
    if (!res.headersSent) {
      res.status(500).json({ 
        error: { 
          message: error.message,
          type: 'proxy_error',
          provider: provider
        }
      });
    }
  }
});

// List models endpoint (for OpenAI compatibility)
app.get('/v1/models', validateApiKey, (req, res) => {
  const models = Object.keys(MODEL_COSTS).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: detectProvider(id)
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgentLog API running on port ${PORT}`);
  const apiKey = db.prepare('SELECT key FROM api_keys LIMIT 1').get();
  console.log(`API Key: ${apiKey.key}`);
  console.log(`Proxy endpoint: POST /v1/chat/completions`);
});

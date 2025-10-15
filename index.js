import fs from 'fs/promises';
import { existsSync } from 'fs';
import express from 'express';
import morgan from 'morgan';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const RATE_LIMIT_SECONDS = process.env.RATE_LIMIT_SECONDS ? Number(process.env.RATE_LIMIT_SECONDS) : 10;
const RATE_LIMIT_EXEMPT = (process.env.RATE_LIMIT_EXEMPT || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// In-memory route store: key = `${method} ${path}`
const routes = new Map();

// Last request timestamp per IP (seconds since epoch)
const lastRequest = new Map();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Utility: atomic write
async function atomicWriteFile(path, data) {
  const tmp = `${path}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { encoding: 'utf8' });
  await fs.rename(tmp, path);
}

// Load persisted routes if present
async function loadRoutes() {
  try {
    if (!existsSync(DATA_FILE)) return;
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach(item => {
        const key = `${(item.method||'GET').toUpperCase()} ${normalizePath(item.path)}.`.slice(0, -1);
      });
    }
    // Normalize to map
    if (Array.isArray(parsed)) {
      parsed.forEach(item => {
        const method = (item.method || 'GET').toUpperCase();
        const path = normalizePath(item.path);
        const key = `${method} ${path}`;
        routes.set(key, {
          method,
          path,
          status: item.status || 200,
          response: item.response,
          headers: item.headers || {}
        });
      });
    }
  } catch (err) {
    console.error('Failed to load routes:', err);
  }
}

// Persist routes array
async function persistRoutes() {
  const arr = [];
  for (const [, v] of routes) {
    arr.push({ path: v.path, method: v.method, status: v.status, response: v.response, headers: v.headers || {} });
  }
  await atomicWriteFile(DATA_FILE, JSON.stringify(arr, null, 2));
}

function normalizePath(p) {
  if (!p) return '/';
  if (!p.startsWith('/')) return '/' + p;
  return p;
}

// Rate limiter middleware
app.use((req, res, next) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    // Exempt paths
    if (RATE_LIMIT_EXEMPT.includes(req.path)) return next();

    const now = Math.floor(Date.now() / 1000);
    const last = lastRequest.get(ip) || 0;
    if (now - last < RATE_LIMIT_SECONDS) {
      const retryAfter = RATE_LIMIT_SECONDS - (now - last);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: retryAfter });
    }
    lastRequest.set(ip, now);
    next();
  } catch (err) {
    // Don't block on errors in rate limiter
    console.error('Rate limiter error', err);
    next();
  }
});

// Control endpoint: register new mock
/**
 * POST /register
 * body: { path, method, response, status, headers }
 */
app.post('/register', async (req, res) => {
  const { path, method = 'GET', response, status = 200, headers = {} } = req.body;
  if (!path || typeof response === 'undefined') {
    return res.status(400).json({ error: 'path and response required' });
  }

  const p = normalizePath(path);
  const m = method.toUpperCase();
  const key = `${m} ${p}`;
  routes.set(key, { method: m, path: p, status: Number(status) || 200, response, headers });

  try {
    await persistRoutes();
  } catch (err) {
    console.error('Failed to persist routes:', err);
    return res.status(500).json({ error: 'Failed to persist route' });
  }

  res.json({ message: 'Registered', method: m, path: p });
});

// List routes
app.get('/__routes', (req, res) => {
  const out = [];
  for (const [, v] of routes) out.push({ path: v.path, method: v.method, status: v.status });
  res.json(out);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Catch-all handler
app.all('*', (req, res) => {
  const key = `${req.method.toUpperCase()} ${normalizePath(req.path)}`;
  const route = routes.get(key);
  if (!route) return res.status(404).json({ error: 'Not found' });

  // Set custom headers if provided
  try {
    if (route.headers && typeof route.headers === 'object') {
      for (const [k, v] of Object.entries(route.headers)) {
        res.set(k, String(v));
      }
    }
  } catch (err) {
    // ignore header errors
  }

  // If response is object/array -> JSON
  if (typeof route.response === 'object') {
    return res.status(route.status).json(route.response);
  }
  // Strings -> send raw
  res.status(route.status).send(String(route.response));
});

// Startup
(async () => {
  await loadRoutes();
  app.listen(PORT, () => console.log(`Mock server listening on ${PORT}`));
})();

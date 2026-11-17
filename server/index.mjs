
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { readBodyAsText } from 'guarded-fetch';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 1024 * 1024;

const WEB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../build/web',
);

// Railway runs behind a reverse proxy.
app.set('trust proxy', 1);

// Limit public proxy usage.
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

// Parse request bodies without changing JSON content.
app.use(
  '/api/proxy',
  proxyLimiter,
  express.raw({
    type: () => true,
    limit: MAX_BYTES,
  }),
);

app.all('/api/proxy', async (req, res) => {
  const method = req.method.toUpperCase();

  if (!['GET', 'POST'].includes(method)) {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  const rawUrl = req.query.url;

  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) {
    return res.status(400).json({
      error: 'Invalid URL parameter',
    });
  }

  let target;

  try {
    target = new URL(rawUrl);

    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new Error('Invalid target URL');
    }
  } catch {
    return res.status(400).json({
      error: 'Invalid target URL',
    });
  }

  try {
    const headers = {
      accept: 'application/json',
    };

    if (method === 'POST') {
      headers['content-type'] = 'application/json';
    }

    const upstream = await fetch(target.href, {
      method,
      headers,
      body: method === 'POST' ? req.body : undefined,
      timeoutMs: 15000,
      redirect: 'error',
      opaqueErrors: true,
    });

    const responseBody = await readBodyAsText(upstream, {
      maxResponseBytes: MAX_BYTES,
    });

    return res
      .status(upstream.status)
      .set({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(responseBody);
  } catch (error) {
    console.error('Proxy request failed:', error);

    return res.status(502).json({
      error: 'External API request failed or was blocked',
    });
  }
});

// Serve compiled Flutter Web files.
app.use(express.static(WEB_DIR));

// GoRouter fallback for browser refreshes.
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api/') || path.extname(req.path)) {
    return res.sendStatus(404);
  }

  return res.sendFile(
    path.join(WEB_DIR, 'index.html'),
  );
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PathFinder listening on port ${PORT}`);
});

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, relative } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4387);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self' https://api.spotify.com https://accounts.spotify.com",
    "img-src 'self' https://i.scdn.co data:",
    "style-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.spotify.com",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = normalize(join(PUBLIC_DIR, requested));
  return relative(PUBLIC_DIR, resolved).startsWith('..') ? null : resolved;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const filePath = safePath(pathname);
    if (!filePath || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, securityHeaders).end('Not found');
      return;
    }

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      response.writeHead(404, securityHeaders).end('Not found');
      return;
    }

    const body = request.method === 'HEAD' ? null : await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body?.length ?? fileStat.size,
    });
    response.end(body || undefined);
  } catch (error) {
    response.writeHead(500, securityHeaders).end('Local server error');
    console.error('Local server error:', error?.code || error?.name || 'unknown');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Canonicalizer is ready at http://${HOST}:${PORT}`);
});

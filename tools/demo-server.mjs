import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff2': 'font/woff2'
};

export function contentTypeFor(path) {
  return TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

export function injectModuleEntry(html, productionSource, demoSource) {
  const escaped = productionSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<script\\s+type=["']module["']\\s+src=["']${escaped}["']\\s*><\\/script>`);
  const replacement = `<script type="module" src="${demoSource}"></script>`;
  if (!pattern.test(html)) throw new Error(`Module entry not found: ${productionSource}`);
  return html.replace(pattern, replacement);
}

function safeFilePath(pathname) {
  const decoded = decodeURIComponent(pathname).replace(/\\/g, '/');
  const candidate = resolve(REPO_ROOT, `.${decoded}`);
  const rootPrefix = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep;
  if (candidate !== REPO_ROOT && !candidate.startsWith(rootPrefix)) throw new Error('Path outside repository');
  return candidate;
}

async function pageBody(pathname) {
  if (pathname === '/dashboard/dashboard.html') {
    const html = await readFile(resolve(REPO_ROOT, 'dashboard/dashboard.html'), 'utf8');
    return injectModuleEntry(html, 'dashboard.js', '/tools/demo-entry.mjs');
  }
  if (pathname === '/src/popup/popup.html') {
    const html = await readFile(resolve(REPO_ROOT, 'src/popup/popup.html'), 'utf8');
    return injectModuleEntry(html, 'popup.js', '/tools/popup-entry.mjs');
  }
  return null;
}

export function startDemoServer({ host = '127.0.0.1', port = 4177 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}:${port}`);
      if (url.pathname === '/') {
        response.writeHead(302, { Location: '/dashboard/dashboard.html#meetings' });
        response.end();
        return;
      }

      const transformed = await pageBody(url.pathname);
      if (transformed != null) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(transformed);
        return;
      }

      let filePath = safeFilePath(url.pathname);
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch (error) {
      const outside = error?.message === 'Path outside repository';
      response.writeHead(outside ? 403 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(outside ? 'Forbidden' : 'Not found');
    }
  });

  return new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveReady({ server, url: `http://${host}:${port}` }));
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const portArg = Number.parseInt(process.argv[2] || '4177', 10);
  const { url } = await startDemoServer({ port: Number.isFinite(portArg) ? portArg : 4177 });
  console.log(`STORE_DEMO_READY ${url}`);
}

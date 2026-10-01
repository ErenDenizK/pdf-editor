/**
 * A small static server that answers like GitHub Pages does for the portfolio site, enough
 * for the redirect folder: `dir/` serves `dir/index.html`, a directory without the slash
 * gets a 301 to it, and a missing path gets the site's root `404.html` with status 404.
 * Files are read from disk on every request, so a test swaps what is served by changing the
 * directory's contents.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export interface Site {
  /** `http://localhost:<port>`: localhost is a secure context, so workers register. */
  readonly origin: string;
  /** The directory served at `/`. */
  readonly root: string;
  /** Every request path, in order. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

export async function startSite(): Promise<Site> {
  const root = await mkdtemp(join(tmpdir(), 'portfolio-redirect-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push(url.pathname);
      const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
      const path = join(root, relative);
      if (path !== root && !path.startsWith(root + sep)) {
        response.writeHead(400).end();
        return;
      }
      let file: string | undefined;
      if (url.pathname.endsWith('/')) {
        if (await isFile(join(path, 'index.html'))) file = join(path, 'index.html');
      } else if (await isFile(path)) {
        file = path;
      } else if (await isDirectory(path)) {
        response.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      // No HTTP caching: the test swaps files under the same URLs and must see the new ones.
      const headers = { 'Cache-Control': 'no-cache' };
      if (file !== undefined) {
        const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
        response.writeHead(200, { ...headers, 'Content-Type': type });
        response.end(await readFile(file));
        return;
      }
      const notFound = join(root, '404.html');
      if (await isFile(notFound)) {
        response.writeHead(404, { ...headers, 'Content-Type': CONTENT_TYPES['.html'] });
        response.end(await readFile(notFound));
      } else {
        response.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found');
      }
    })().catch((error: unknown) => {
      console.error(error);
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    root,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

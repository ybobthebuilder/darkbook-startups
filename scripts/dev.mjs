#!/usr/bin/env node
import { createServer } from 'node:http';
import { execute, read, registryFile, schemaFile } from './lib.mjs';
import { validateAndLog } from './validate-schema.mjs';

await execute('dev', async (log) => {
  validateAndLog(log);
  const port = process.env.PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const resources = new Map([
    ['/', ['application/json; charset=utf-8', JSON.stringify({
      scope: 'F0: servidor local de contratos; não é a aplicação DARWIN.',
      resources: ['/health', '/contract.graphql', '/gate-registry.json'],
      release_decision: 'NO_GO',
    })]],
    ['/health', ['application/json; charset=utf-8', '{"status":"ok","scope":"F0","release_decision":"NO_GO"}']],
    ['/contract.graphql', ['text/plain; charset=utf-8', read(schemaFile)]],
    ['/gate-registry.json', ['application/json; charset=utf-8', read(registryFile)]],
  ]);
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    // Exact raw request-target lookup: no path decoding, normalization or file IO.
    const resource = resources.get(request.url);
    if (!resource) {
      response.writeHead(404).end();
      return;
    }
    const [contentType, body] = resource;
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    const shutdown = () => {
      log('Encerrando servidor F0.');
      server.close();
      server.closeAllConnections();
    };
    const cleanup = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    };
    server.on('error', (error) => { cleanup(); reject(error); });
    server.on('close', () => { cleanup(); resolve(); });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    server.listen(Number(port), '127.0.0.1', () => {
      log(`LISTENING http://127.0.0.1:${server.address().port}`);
      log('Escopo F0: recursos estáticos; sem aplicação, persistência ou execução GraphQL.');
    });
  });
});

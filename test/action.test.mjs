import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => (stdout += value));
    child.stderr.on('data', (value) => (stderr += value));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('main masks secrets, exports the attachment, and saves cleanup state', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/browser-leases') response.end(JSON.stringify({ id: 'blease_test', state: 'creating' }));
    else if (request.url === '/browser-leases/blease_test') response.end(JSON.stringify({ id: 'blease_test', state: 'ready' }));
    else response.end(JSON.stringify({ url: 'wss://secret.example/cdp?token=signed', expiresAt: new Date().toISOString() }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'botyard-action-'));
  const envFile = join(directory, 'env');
  const stateFile = join(directory, 'state');
  const address = server.address();
  const result = await run({
    ...process.env,
    INPUT_API_URL: `http://127.0.0.1:${address.port}`,
    INPUT_API_KEY: 'botyard_test_secret', INPUT_TTL_MINUTES: '30',
    GITHUB_ENV: envFile, GITHUB_STATE: stateFile, GITHUB_REPOSITORY: 'ak5/example'
  });
  server.close();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /::add-mask::botyard_test_secret/);
  assert.match(result.stdout, /::add-mask::wss:\/\/secret\.example/);
  assert.doesNotMatch(result.stdout, /BOTYARD_CDP_URL/);
  assert.match(await readFile(envFile, 'utf8'), /BOTYARD_CDP_URL/);
  assert.match(await readFile(stateFile, 'utf8'), /blease_test/);
  assert.deepEqual(requests, ['POST /browser-leases', 'GET /browser-leases/blease_test', 'POST /browser-leases/blease_test/attachment']);
});

test('post cleanup is idempotent', async () => {
  let deleted = false;
  const server = createServer((request, response) => {
    deleted = request.method === 'DELETE' && request.url === '/browser-leases/blease_test';
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const result = await run({ ...process.env, INPUT_API_URL: `http://127.0.0.1:${address.port}`, INPUT_API_KEY: 'botyard_test_secret', STATE_LEASE_ID: 'blease_test' });
  server.close();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(deleted, true);
});

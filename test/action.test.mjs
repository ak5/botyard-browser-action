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
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      { env }
    );
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
    if (request.url === '/browser-leases')
      response.end(
        JSON.stringify({
          id: 'blease_test',
          state: 'creating',
          startDeadlineAt: new Date(Date.now() + 60000).toISOString(),
          expiresAt: new Date(Date.now() + 1800000).toISOString()
        })
      );
    else if (request.url === '/browser-leases/blease_test')
      response.end(JSON.stringify({ id: 'blease_test', state: 'ready' }));
    else
      response.end(
        JSON.stringify({
          url: 'wss://secret.example/cdp?token=signed',
          expiresAt: new Date().toISOString()
        })
      );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'botyard-action-'));
  const envFile = join(directory, 'env');
  const stateFile = join(directory, 'state');
  const address = server.address();
  const result = await run({
    ...process.env,
    'INPUT_API-URL': `http://127.0.0.1:${address.port}`,
    'INPUT_API-KEY': 'botyard_test_secret',
    'INPUT_TTL-MINUTES': '30',
    GITHUB_ENV: envFile,
    GITHUB_STATE: stateFile,
    GITHUB_REPOSITORY: 'ak5/example'
  });
  server.close();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /::add-mask::botyard_test_secret/);
  assert.match(result.stdout, /::add-mask::wss:\/\/secret\.example/);
  assert.doesNotMatch(result.stdout, /BOTYARD_CDP_URL/);
  assert.match(await readFile(envFile, 'utf8'), /BOTYARD_CDP_URL/);
  assert.match(await readFile(stateFile, 'utf8'), /blease_test/);
  assert.match(await readFile(stateFile, 'utf8'), /IS_POST<<BOTYARD_EOF\ntrue/);
  assert.deepEqual(requests, [
    'POST /browser-leases',
    'GET /browser-leases/blease_test',
    'POST /browser-leases/blease_test/attachment'
  ]);
});

test('post cleanup is idempotent', async () => {
  let deletes = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, '/browser-leases/blease_test');
    response.statusCode = ++deletes === 1 ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run({
        ...process.env,
        'INPUT_API-URL': `http://127.0.0.1:${address.port}`,
        'INPUT_API-KEY': 'botyard_test_secret',
        STATE_IS_POST: 'true',
        STATE_LEASE_ID: 'blease_test'
      });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(deletes, 2);
  } finally {
    server.close();
  }
});

test('creation retries keep one idempotency key and never log response bodies', async () => {
  const keys = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/browser-leases') {
      keys.push(request.headers['idempotency-key']);
      response.statusCode = keys.length === 1 ? 503 : 400;
      response.end(JSON.stringify({ error: 'sensitive-fixture-value' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const directory = await mkdtemp(join(tmpdir(), 'botyard-action-'));
    const result = await run({
      ...process.env,
      'INPUT_API-URL': `http://127.0.0.1:${server.address().port}`,
      'INPUT_API-KEY': 'fixture-key',
      GITHUB_STATE: join(directory, 'state')
    });
    assert.equal(result.code, 1);
    assert.equal(keys.length, 2);
    assert.ok(keys[0]);
    assert.equal(keys[0], keys[1]);
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-fixture-value/);
    assert.match(await readFile(join(directory, 'state'), 'utf8'), /IS_POST<<BOTYARD_EOF\ntrue/);
    const post = await run({
      ...process.env,
      'INPUT_API-URL': `http://127.0.0.1:${server.address().port}`,
      'INPUT_API-KEY': 'fixture-key',
      STATE_IS_POST: 'true',
      STATE_LEASE_ID: ''
    });
    assert.equal(post.code, 0, post.stderr);
    assert.equal(keys.length, 2, 'post without a lease must not acquire another browser');
  } finally {
    server.close();
  }
});

for (const scenario of ['expired', 'invalid', 'expiry-before-startup', 'failed']) {
  test(`startup rejects ${scenario} without exposing server details`, async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: 'blease_test',
        state: scenario === 'failed' ? 'failed' : 'creating',
        startDeadlineAt: scenario === 'invalid' ? 'invalid' :
          new Date(Date.now() + (scenario === 'expired' ? -1000 : 60000)).toISOString(),
        expiresAt: new Date(Date.now() + (scenario === 'expiry-before-startup' ? -1000 : 60000)).toISOString(),
        failureReason: 'sensitive-fixture-value'
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const directory = await mkdtemp(join(tmpdir(), 'botyard-action-'));
      const result = await run({
        ...process.env,
        'INPUT_API-URL': `http://127.0.0.1:${server.address().port}`,
        'INPUT_API-KEY': 'fixture-key',
        GITHUB_STATE: join(directory, 'state')
      });
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout + result.stderr, /sensitive-fixture-value/);
      assert.deepEqual(requests, ['/browser-leases']);
      assert.match(await readFile(join(directory, 'state'), 'utf8'), /blease_test/);
    } finally {
      server.close();
    }
  });
}

test('a stalled poll cannot outlive the server startup deadline', async () => {
  let deadline;
  let polls = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { polls++; return; }
    deadline = Date.now() + 3000;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'blease_test', state: 'creating',
      startDeadlineAt: new Date(deadline).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const directory = await mkdtemp(join(tmpdir(), 'botyard-action-'));
    const result = await run({
      ...process.env,
      'INPUT_API-URL': `http://127.0.0.1:${server.address().port}`,
      'INPUT_API-KEY': 'fixture-key',
      GITHUB_STATE: join(directory, 'state')
    });
    assert.equal(result.code, 1);
    assert.equal(polls, 1);
    assert.ok(Date.now() < deadline + 5000, 'poll used its full 15-second request timeout');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

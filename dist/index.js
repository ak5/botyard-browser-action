import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const apiUrl = (process.env['INPUT_API-URL'] || '').replace(/\/$/, '');
const apiKey = process.env['INPUT_API-KEY'] || '';

function command(name, value) {
  const escaped = String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::${name}::${escaped}\n`);
}
function append(file, name, value) {
  if (!file) throw new Error(`Missing GitHub command file for ${name}`);
  fs.appendFileSync(file, `${name}<<BOTYARD_EOF\n${value}\nBOTYARD_EOF\n`);
}
async function request(path, init = {}, deadline = Infinity) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) {
    throw new Error(`Botyard request failed (${response.status})`);
  }
  return response.json();
}
async function cleanup() {
  const leaseId = process.env.STATE_LEASE_ID;
  if (!leaseId || !apiUrl || !apiKey) return;
  const response = await fetch(`${apiUrl}/browser-leases/${encodeURIComponent(leaseId)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok && response.status !== 404) throw new Error(`Botyard cleanup failed (${response.status})`);
}
async function main() {
  append(process.env.GITHUB_STATE, 'IS_POST', 'true');
  if (!apiUrl || !apiKey) throw new Error('api-url and api-key are required');
  command('add-mask', apiKey);
  const ttlMinutes = Number(process.env['INPUT_TTL-MINUTES'] || 30);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 120) throw new Error('ttl-minutes must be an integer from 5 to 120');
  // A request identity per action invocation also separates matrix jobs.
  const requestKey = randomUUID();
  append(process.env.GITHUB_STATE, 'REQUEST_KEY', requestKey);
  const input = {
    method: 'POST',
    headers: { 'Idempotency-Key': requestKey },
    body: JSON.stringify({ ttlMinutes, auditContext: {
      repository: process.env.GITHUB_REPOSITORY, workflow: process.env.GITHUB_WORKFLOW,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB
    } })
  };
  let lease;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { lease = await request('/browser-leases', input); break; }
    catch (error) {
      if (attempt === 2 || /\(4\d\d\)/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  append(process.env.GITHUB_STATE, 'LEASE_ID', lease.id);
  const deadline = Math.min(Date.parse(lease.startDeadlineAt), Date.parse(lease.expiresAt));
  if (!Number.isFinite(deadline)) throw new Error('Botyard returned an invalid startup deadline');
  let current = lease;
  while (current.state === 'creating' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, deadline-Date.now()))));
    if (Date.now() >= deadline) break;
    current = await request(`/browser-leases/${encodeURIComponent(lease.id)}`, {}, deadline);
  }
  if (current.state !== 'ready') throw new Error(`Browser startup failed (${current.state})`);
  const attachment = await request(`/browser-leases/${encodeURIComponent(lease.id)}/attachment`, { method: 'POST', body: '{}' });
  command('add-mask', attachment.url);
  append(process.env.GITHUB_ENV, 'BOTYARD_CDP_URL', attachment.url);
}
(process.env.STATE_IS_POST === 'true' ? cleanup() : main()).catch((error) => {
  command('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

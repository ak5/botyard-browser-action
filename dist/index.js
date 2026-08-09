import fs from 'node:fs';
const apiUrl = (process.env.INPUT_API_URL || '').replace(/\/$/, '');
const apiKey = process.env.INPUT_API_KEY || '';

function command(name, value) {
  const escaped = String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::${name}::${escaped}\n`);
}
function append(file, name, value) {
  if (!file) throw new Error(`Missing GitHub command file for ${name}`);
  fs.appendFileSync(file, `${name}<<BOTYARD_EOF\n${value}\nBOTYARD_EOF\n`);
}
async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Botyard request failed (${response.status}): ${body.error || 'unknown error'}`);
  }
  return response.json();
}
async function cleanup() {
  const leaseId = process.env.STATE_LEASE_ID;
  if (!leaseId || !apiUrl || !apiKey) return;
  const response = await fetch(`${apiUrl}/browser-leases/${encodeURIComponent(leaseId)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok && response.status !== 404) throw new Error(`Botyard cleanup failed (${response.status})`);
}
async function main() {
  if (!apiUrl || !apiKey) throw new Error('api-url and api-key are required');
  command('add-mask', apiKey);
  const ttlMinutes = Number(process.env.INPUT_TTL_MINUTES || 30);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 120) throw new Error('ttl-minutes must be an integer from 5 to 120');
  const lease = await request('/browser-leases', {
    method: 'POST',
    body: JSON.stringify({ ttlMinutes, auditContext: {
      repository: process.env.GITHUB_REPOSITORY, workflow: process.env.GITHUB_WORKFLOW,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB
    } })
  });
  append(process.env.GITHUB_STATE, 'LEASE_ID', lease.id);
  const deadline = Date.now() + Math.min(ttlMinutes * 60_000, 10 * 60_000);
  let current = lease;
  while (current.state === 'creating' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    current = await request(`/browser-leases/${encodeURIComponent(lease.id)}`);
  }
  if (current.state !== 'ready') throw new Error(`Browser lease did not become ready (state: ${current.state})`);
  const attachment = await request(`/browser-leases/${encodeURIComponent(lease.id)}/attachment`, { method: 'POST', body: '{}' });
  command('add-mask', attachment.url);
  append(process.env.GITHUB_ENV, 'BOTYARD_CDP_URL', attachment.url);
}
(process.env.STATE_LEASE_ID ? cleanup() : main()).catch((error) => {
  command('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

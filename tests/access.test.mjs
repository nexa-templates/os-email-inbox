import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessUser, needsEditorAccess } from '../src/access.js';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture' };
const env = { ACCESS_ISSUER: 'https://nexa-template-test.cloudflareaccess.com', ACCESS_AUD: 'template-fixture', APP_ORIGIN: 'https://app.example.test' };
async function token(change = {}) {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({ iss: env.ACCESS_ISSUER, aud: [env.ACCESS_AUD], sub: 'member', email: 'member@example.test', exp: now + 300, iat: now, ...change });
  return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
const keys = async url => { assert.equal(url, env.ACCESS_ISSUER + '/cdn-cgi/access/certs'); return Response.json({ keys: [publicKey] }); };
test('Access validates signature, audience, lifetime, hostname and request origin', async () => {
  const signed = await token(), request = (value, options = {}) => new Request(env.APP_ORIGIN + '/api/items', { ...options, headers: { 'cf-access-jwt-assertion': value, ...options.headers } });
  assert.deepEqual(await accessUser(request(signed), env, keys), { id: 'member', email: 'member@example.test' });
  await assert.rejects(accessUser(request(signed), {}, keys), { status: 503 });
  await assert.rejects(accessUser(new Request('https://alternate.workers.dev/', { headers: { 'cf-access-jwt-assertion': signed } }), env, keys), { status: 403 });
  for (const change of [{ aud: ['other'] }, { iss: 'https://other.cloudflareaccess.com' }, { exp: 1 }, { nbf: 'invalid' }, { sub: '' }, { iat: Math.floor(Date.now() / 1000) + 100 }]) await assert.rejects(accessUser(request(await token(change)), env, keys), { status: 401 });
  const forged = signed.split('.'); forged[1] = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');
  await assert.rejects(accessUser(request(forged.join('.')), env, keys), { status: 401 });
  await assert.rejects(accessUser(request(signed, { method: 'POST', headers: { origin: 'https://other.example.test' } }), env, keys), { status: 403 });
  assert.equal((await accessUser(request(signed, { method: 'POST', headers: { origin: env.APP_ORIGIN } }), env, keys)).id, 'member');
});
test('Only the website editor, preview and private site APIs require editor Access', () => {
  for (const path of ['/editor', '/editor/site', '/preview', '/preview/page', '/api/sites', '/api/sites/id']) assert.equal(needsEditorAccess(path), true);
  for (const path of ['/', '/page', '/api/public/id/messages', '/editorial', '/api/sites-public']) assert.equal(needsEditorAccess(path), false);
});

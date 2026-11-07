// Standalone Cloudflare Access verification. This file has no Nexa dependency.
const cache = new Map();
const reject = (message, status = 401) => Object.assign(new Error(message), { status });
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export async function accessUser(request, env, load = fetch) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER || '') || !env.ACCESS_AUD || !env.APP_ORIGIN) throw reject('Configure Cloudflare Access and the application hostname.', 503);
  if (new URL(request.url).origin !== env.APP_ORIGIN) throw reject('Use the application hostname.', 403);
  const encoded = request.headers.get('cf-access-jwt-assertion') || '';
  if (encoded.length > 16384) throw reject('Invalid Access token.');
  try {
    const parts = encoded.split('.'); if (parts.length !== 3) throw reject('Sign in through Cloudflare Access.');
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw reject('Invalid Access signature.');
    let keys = cache.get(env.ACCESS_ISSUER);
    if (!keys || keys.until < Date.now() || !keys.values.some(k => k.kid === header.kid)) {
      const response = await load(env.ACCESS_ISSUER + '/cdn-cgi/access/certs', { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw reject('Sign-in verification is unavailable.', 503);
      const data = await response.json(); if (!Array.isArray(data.keys)) throw reject('Sign-in verification is unavailable.', 503);
      keys = { values: data.keys, until: Date.now() + 300000 }; cache.set(env.ACCESS_ISSUER, keys);
    }
    const jwk = keys.values.find(k => k.kid === header.kid && k.kty === 'RSA'); if (!jwk) throw reject('Unknown Access key.');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw reject('Invalid Access signature.');
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))), now = Math.floor(Date.now() / 1000);
    if (claims.iss !== env.ACCESS_ISSUER || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD) || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 30 || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30) || typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string' || !claims.email.includes('@')) throw reject('Invalid or expired Access login.');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== env.APP_ORIGIN) throw reject('Invalid request origin.', 403);
    return { id: claims.sub, email: claims.email.toLowerCase() };
  } catch (error) { throw error.status ? error : reject('Invalid Access token.'); }
}
export function accessFailure(error) {
  return new Response(error.status ? error.message : 'Sign-in is unavailable.', { status: error.status || 503, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}
export function needsEditorAccess(path) { return /^\/(?:editor|preview)(?:\/|$)/.test(path) || /^\/api\/sites(?:\/|$)/.test(path); }

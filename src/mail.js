const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const valid = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>\x00-\x1f]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
export function directAddresses(env) {
  const values = (env.EMAIL_ADDRESSES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!values.length || values.length > 32 || values.some(value => !valid(value))) throw failure('Configure the receiving and sending addresses.', 503);
  return [...new Set(values)];
}
async function provider(env, path, init = {}) {
  if (!env.NEXA_SERVICE_KEY || !/^[a-f0-9]{32}$/.test(env.NEXA_INSTALLATION_ID || '')) throw failure('Connect this inbox to its Nexa service installation.', 503);
  const origin = new URL(env.NEXA_SERVICE_ORIGIN || 'https://services.nexaintel.work');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash) throw failure('Use a secure Nexa service origin.', 503);
  const response = await fetch(origin.origin + '/v1' + path, { ...init, headers: { ...init.headers, authorization: 'Bearer ' + env.NEXA_SERVICE_KEY, 'x-nexa-installation': env.NEXA_INSTALLATION_ID }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw failure('The email provider could not complete this request.', response.status);
  return response;
}
export async function mailboxSettings(env) {
  if (env.PREVIEW_MODE === 'true') throw failure('Live email is disabled in preview.', 403);
  if (env.EMAIL_PROVIDER === 'nexa') {
    const value = await (await provider(env, '/email/config')).json();
    if (!Array.isArray(value.addresses) || !value.addresses.length || value.addresses.some(address => !valid(address))) throw failure('Assign a receiving alias to this inbox installation.', 409);
    return { addresses: value.addresses, sender: value.addresses[0] };
  }
  if (env.EMAIL_PROVIDER !== 'cloudflare') throw failure('Choose an email provider.', 503);
  const addresses = directAddresses(env); return { addresses, sender: addresses[0] };
}
export function outgoingMessage(input, addresses) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['to', 'from', 'replyTo', 'subject', 'text', 'html', 'attachments', 'inReplyTo', 'references'].includes(key))) throw failure('Invalid email.');
  if (input.from !== undefined && typeof input.from !== 'string' || input.replyTo !== undefined && typeof input.replyTo !== 'string') throw failure('Choose an owned sender address.', 403);
  const from = (input.from || addresses[0]).toLowerCase(), replyTo = (input.replyTo || from).toLowerCase();
  if (!addresses.includes(from) || !addresses.includes(replyTo)) throw failure('Choose an owned sender address.', 403);
  if (!valid(input.to) || typeof input.subject !== 'string' || !input.subject || input.subject.length > 998 || /[\r\n\x00]/.test(input.subject) || !(typeof input.text === 'string' && input.text || typeof input.html === 'string' && input.html)) throw failure('Enter a recipient, subject and message.');
  if ([input.text, input.html].some(value => value !== undefined && typeof value !== 'string') || new TextEncoder().encode((input.text || '') + (input.html || '')).length > 262144) throw failure('Email text must fit within 256 KiB.', 413);
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 10)) throw failure('Attach up to 10 files.');
  let length = 0;
  const attachments = (input.attachments || []).map(file => {
    if (!file || typeof file.filename !== 'string' || !file.filename || file.filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(file.filename) || typeof file.type !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(file.type) || typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw failure('Invalid attachment.');
    const content = Uint8Array.from(atob(file.content), c => c.charCodeAt(0)); length += content.length;
    if (length > 5 * 1024 * 1024) throw failure('Attachments must total no more than 5 MiB.', 413);
    return { filename: file.filename, type: file.type, disposition: 'attachment', content };
  });
  const headers = {};
  for (const [field, name, maximum] of [['inReplyTo', 'In-Reply-To', 1], ['references', 'References', 20]]) if (input[field]) {
    const value = input[field]; if (typeof value !== 'string' || value.length > 4096 || value.split(' ').length > maximum || value.split(' ').some(part => !/^<[^<>\s\x00-\x1f]+@[^<>\s\x00-\x1f]+>$/.test(part))) throw failure('Invalid reply threading.'); headers[name] = value;
  }
  return { from: { email: from }, to: input.to.toLowerCase(), replyTo, subject: input.subject, text: input.text, html: input.html, ...(attachments.length ? { attachments } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
}
export async function mailService(env, path, init = {}) {
  if (env.PREVIEW_MODE === 'true') throw failure('Live email is disabled in preview.', 403);
  if (env.EMAIL_PROVIDER === 'nexa') {
    const response = await provider(env, path, init);
    if (path !== '/email/incoming') return response;
    const body = await response.json(), settings = await (await provider(env, '/email/config')).json();
    return Response.json({ ...body, messages: body.messages.map(message => ({ ...message, recipient: settings.addresses.find(address => address.split('@')[0].endsWith('+' + message.alias)) || '', receivedAt: message.received_at, authenticated: false })) });
  }
  if (env.EMAIL_PROVIDER !== 'cloudflare') throw failure('Choose an email provider.', 503);
  if (path === '/email/incoming') return Response.json({ messages: [], next: null });
  if (path !== '/email/send' || init.method !== 'POST' || !env.EMAIL) throw failure('Email sending is not configured.', 503);
  const data = outgoingMessage(JSON.parse(init.body), directAddresses(env));
  // The Mailbox records the attempt before this call and never retries an uncertain send.
  try { const result = await env.EMAIL.send(data); return Response.json({ status: 'accepted', messageId: result.messageId }); }
  catch { return Response.json({ status: 'unknown' }, { status: 202 }); }
}

import { DurableObject } from 'cloudflare:workers';
import PostalMime from 'postal-mime';
import { accessUser, accessFailure } from './access.js';
import { directAddresses, mailboxSettings, mailService as nexa } from './mail.js';
import { isPreview, previewResponse } from './preview.js';

const MAX_MAIL = 5 * 1024 * 1024, MAX_STORE = 512 * 1024 * 1024, CHUNK = 128 * 1024;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safeName = value => String(value || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
const ids = value => (String(value || '').match(/<[^<>\s]+@[^<>\s]+>/g) || []).slice(-20).join(' ');
async function bytes(request, limit) {
  const reader = request.body?.getReader(); if (!reader) throw fail('A request body is required.');
  const chunks = []; let length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) { await reader.cancel(); throw fail('Message is too large.', 413); } chunks.push(part.value); }
  const value = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; } return value;
}
export class Mailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.sql = ctx.storage.sql; this.syncing = null; this.sending = new Set();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread TEXT NOT NULL, address TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, preview TEXT NOT NULL, received_at INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL DEFAULT 'Inbox', format TEXT NOT NULL DEFAULT 'mime', bytes INTEGER NOT NULL, authenticated INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS mail_folder ON messages(folder,received_at);
      CREATE INDEX IF NOT EXISTS mail_thread ON messages(thread);
      CREATE TABLE IF NOT EXISTS content(id TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,part));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',result TEXT);`);
  }
  get(key) { return this.sql.exec('SELECT value FROM meta WHERE key=?', key).toArray()[0]?.value; }
  set(key, value) { this.sql.exec('INSERT OR REPLACE INTO meta VALUES(?,?)', key, value); }
  raw(id) { const chunks = this.sql.exec('SELECT data FROM content WHERE id=? ORDER BY part', id).toArray().map(r => new Uint8Array(r.data)); const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output; }
  capacity(length, id) {
    const size = this.sql.exec('SELECT COALESCE(SUM(bytes),0) AS n,COUNT(*) AS messages FROM messages').one();
    const reserved = this.sql.exec("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS n,COUNT(*) AS messages FROM drafts WHERE id<>? AND status IN ('pending','unknown','accepted') AND NOT EXISTS(SELECT 1 FROM messages WHERE messages.id=drafts.id)", id).one();
    if (size.n + reserved.n + length > MAX_STORE || size.messages + reserved.messages >= 10000) throw fail('Mailbox storage is full. Export and remove old mail before syncing or sending.', 413);
  }
  save(delivery, raw, parsed) {
    if (this.sql.exec('SELECT id FROM messages WHERE id=?', delivery.id).toArray().length) return;
    this.capacity(raw.length, delivery.id);
    const parentIDs = ids(parsed.inReplyTo || parsed.references).split(' ').reverse(); let thread;
    for (const parent of parentIDs) { const match = this.sql.exec('SELECT thread FROM messages WHERE message_id=? AND address=? LIMIT 1', parent, delivery.recipient).toArray()[0]; if (match) { thread = match.thread; break; } }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO messages(id,thread,address,sender,recipient,subject,preview,received_at,bytes,authenticated,message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', delivery.id, thread || delivery.id, delivery.recipient, parsed.from?.address || delivery.sender || '', (parsed.to || []).map(a => a.address || '').join(', ').slice(0, 1000), (parsed.subject || '(No subject)').slice(0, 998), String(parsed.text || '').slice(0, 200), delivery.receivedAt, raw.length, +!!delivery.authenticated, ids(parsed.messageId));
      for (let offset = 0, part = 0; offset < raw.length; offset += CHUNK, part++) this.sql.exec('INSERT INTO content VALUES(?,?,?)', delivery.id, part, raw.slice(offset, offset + CHUNK));
    });
  }
  async receive(raw, recipient, sender) {
    if (this.env.PREVIEW_MODE === 'true' || this.env.EMAIL_PROVIDER !== 'cloudflare' || !directAddresses(this.env).includes(recipient) || raw.length > MAX_MAIL) throw fail('Delivery denied.', 403);
    const digest = await crypto.subtle.digest('SHA-256', raw), fingerprint = new TextEncoder().encode(recipient + ':' + sender + ':' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
    const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprint)), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    this.save({ id: key, recipient, sender, receivedAt: Date.now(), authenticated: false }, raw, await PostalMime.parse(raw));
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const info = await (await nexa(this.env, '/email/incoming')).json();
        const settings = await mailboxSettings(this.env);
        this.set('addresses', JSON.stringify(settings.addresses));
        this.set('sender', settings.sender);
        // Process a bounded batch; subsequent cron runs resume the queue.
        for (const delivery of info.messages.slice(0, 10)) {
          if (!this.sql.exec('SELECT id FROM messages WHERE id=?', delivery.id).toArray().length) {
            const response = await nexa(this.env, '/email/incoming/' + delivery.id), raw = await bytes(response, MAX_MAIL);
            const parsed = await PostalMime.parse(raw); this.save(delivery, raw, parsed);
          }
          await nexa(this.env, '/email/incoming/' + delivery.id + '/ack', { method: 'POST' });
        }
        this.set('lastSync', String(Date.now())); this.set('syncError', '');
        return { saved: info.messages.length > 10 ? 10 : info.messages.length, remaining: info.messages.length > 10 || !!info.next };
      } catch (error) { this.set('syncError', error.status ? error.message : 'Sync was interrupted. It will retry automatically.'); throw error; }
    })();
    try { return await this.syncing; } finally { this.syncing = null; }
  }
  list(url) {
    const folder = url.searchParams.get('folder') || 'Inbox', address = url.searchParams.get('address') || '', query = (url.searchParams.get('q') || '').slice(0, 200), offset = Math.max(0, Math.min(10000, Number(url.searchParams.get('offset')) || 0));
    const where = [folder === 'Starred' ? 'starred=1 AND folder<>\'Trash\'' : 'folder=?'], args = folder === 'Starred' ? [] : [folder];
    if (address) { where.push('address=?'); args.push(address); }
    if (query) { where.push("(instr(lower(subject),lower(?))>0 OR instr(lower(sender),lower(?))>0 OR instr(lower(preview),lower(?))>0)"); args.push(query, query, query); }
    if (url.searchParams.get('unread') === '1') where.push('unread=1');
    return { messages: this.sql.exec('SELECT * FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY received_at DESC,id LIMIT 50 OFFSET ?', ...args, offset).toArray(), total: this.sql.exec('SELECT COUNT(*) AS n FROM messages WHERE ' + where.join(' AND '), ...args).one().n, addresses: JSON.parse(this.get('addresses') || '[]'), sender: this.get('sender') || '', lastSync: Number(this.get('lastSync') || 0), syncError: this.get('syncError') || '', drafts: this.sql.exec("SELECT id,substr(json_extract(body,'$.to'),1,254) AS recipient,substr(json_extract(body,'$.subject'),1,998) AS subject,updated_at,version,status FROM drafts ORDER BY updated_at DESC LIMIT 100").toArray().map(d => ({ ...d, body: { to: d.recipient, subject: d.subject } })) };
  }
  async handle(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/messages' && method === 'GET') return json(this.list(url));
    if (path === '/api/sync' && method === 'POST') { if (request.body) await bytes(request, 1024); return json(await this.sync()); }
    const message = path.match(/^\/api\/messages\/([a-f0-9-]{32,36})(?:\/(raw|attachment\/(\d+)))?$/);
    if (message) {
      const row = this.sql.exec('SELECT * FROM messages WHERE id=?', message[1]).toArray()[0]; if (!row) throw fail('Message not found.', 404);
      if (method === 'DELETE' && !message[2]) { if (row.folder !== 'Trash') throw fail('Move this message to Trash before permanently deleting it.'); this.ctx.storage.transactionSync(() => { this.sql.exec('DELETE FROM content WHERE id=?', row.id); this.sql.exec('DELETE FROM messages WHERE id=?', row.id); }); return json({ deleted: true }); }
      if (method === 'PATCH' && !message[2]) {
        const body = JSON.parse(new TextDecoder().decode(await bytes(request, 4096)));
        if (body.folder !== undefined && !['Inbox', 'Archive', 'Trash'].includes(body.folder)) throw fail('Choose Inbox, Archive or Trash.');
        if (['unread', 'starred'].some(k => body[k] !== undefined && typeof body[k] !== 'boolean')) throw fail('Invalid message flags.');
        this.sql.exec('UPDATE messages SET folder=?,unread=?,starred=? WHERE id=?', body.folder ?? row.folder, body.unread === undefined ? row.unread : +body.unread, body.starred === undefined ? row.starred : +body.starred, row.id); return json({ saved: true });
      }
      if (method !== 'GET') throw fail('Use GET, PATCH or DELETE.', 405);
      const raw = this.raw(row.id);
       if (message[2] === 'raw') return new Response(raw, { headers: { 'content-type': row.format === 'json' ? 'application/json' : 'message/rfc822', 'content-disposition': 'attachment; filename="message.' + (row.format === 'json' ? 'json' : 'eml') + '"', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'no-store' } });
       const parsed = row.format === 'json' ? JSON.parse(new TextDecoder().decode(raw)) : await PostalMime.parse(raw);
      if (message[3] !== undefined) { const file = parsed.attachments?.[Number(message[3])]; if (!file) throw fail('Attachment not found.', 404); const content = typeof file.content === 'string' ? Uint8Array.from(atob(file.content), c => c.charCodeAt(0)) : file.content; return new Response(content, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(safeName(file.filename)), 'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff' } }); }
       return json({ ...row, text: parsed.text || '', html: parsed.html || '', replyTo: row.format === 'json' ? row.recipient : parsed.replyTo?.[0]?.address || parsed.from?.address || row.sender, inReplyTo: ids(row.message_id), references: ids((parsed.references || '') + ' ' + row.message_id), attachments: (parsed.attachments || []).map((a, index) => ({ index, filename: safeName(a.filename), bytes: typeof a.content === 'string' ? Math.floor(a.content.length * 3 / 4) : a.content.byteLength })), threadMessages: this.sql.exec('SELECT id,subject,sender,received_at FROM messages WHERE thread=? ORDER BY received_at', row.thread).toArray() });
    }
    const draft = path.match(/^\/api\/drafts\/([a-f0-9-]{36})(\/send)?$/);
    if (draft) {
      let row = this.sql.exec('SELECT * FROM drafts WHERE id=?', draft[1]).toArray()[0];
      if (!draft[2] && method === 'PUT') {
        const body = JSON.parse(new TextDecoder().decode(await bytes(request, 8 * 1024 * 1024)));
        row = this.sql.exec('SELECT * FROM drafts WHERE id=?', draft[1]).toArray()[0];
        if (row && row.status !== 'draft') throw fail('This send has already started. Its content cannot be changed.', 409);
        if (row && body.version !== row.version) throw fail('Someone else changed this draft. Reload before saving.', 409);
        const data = body.message;
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.to !== 'string' || typeof data.subject !== 'string' || typeof data.text !== 'string') throw fail('Enter a recipient, subject and message.');
        // Keep large files out of a single SQLite row. Draft attachments are capped at 512 KiB.
        const value = JSON.stringify(data); if (new TextEncoder().encode(value).length > 800000) throw fail('Drafts must fit within 800 KB, including attachments.', 413);
        if (!row && this.sql.exec('SELECT COUNT(*) AS n FROM drafts').one().n >= 100) throw fail('Remove an old draft before creating another.', 413);
        this.sql.exec("INSERT INTO drafts(id,body,updated_at,version) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at,version=version+1", draft[1], value, Date.now());
        return json({ id: draft[1], version: (row?.version || 0) + 1 });
      }
      if (!row) throw fail('Draft not found.', 404);
      if (!draft[2] && method === 'GET') return json({ ...row, body: JSON.parse(row.body), result: row.result ? JSON.parse(row.result) : null });
      if (!draft[2] && method === 'DELETE') { if (row.status !== 'draft' && row.status !== 'accepted' && row.status !== 'rejected') throw fail('This send is unconfirmed. Keep its record to avoid duplicate delivery.', 409); this.sql.exec('DELETE FROM drafts WHERE id=?', row.id); return json({ deleted: true }); }
      if (draft[2] && method === 'POST') {
          if (request.body) await bytes(request, 1024);
          row = this.sql.exec('SELECT * FROM drafts WHERE id=?', draft[1]).toArray()[0];
          if (!row) throw fail('Draft not found.', 404);
         if (row.status === 'accepted' || row.status === 'rejected') return json(JSON.parse(row.result));
         if (this.sending.has(row.id)) return json({ status: 'pending' }, 202);
         if (row.status === 'pending' || row.status === 'unknown') return json({ status: 'unknown' }, 202);
         this.capacity(new TextEncoder().encode(row.body).length, row.id);
        this.sending.add(row.id);
        this.sql.exec("UPDATE drafts SET status='pending' WHERE id=?", row.id);
        try {
          const response = await nexa(this.env, '/email/send', { method: 'POST', body: row.body, headers: { 'content-type': 'application/json', 'idempotency-key': 'inbox-' + row.id } }), result = await response.json();
           this.ctx.storage.transactionSync(() => {
           if (result.status === 'accepted' && !this.sql.exec('SELECT id FROM messages WHERE id=?', row.id).toArray().length) {
             const body = JSON.parse(row.body), raw = new TextEncoder().encode(row.body);
             this.save({ id: row.id, recipient: body.from || this.get('sender'), sender: body.from || this.get('sender'), receivedAt: Date.now(), authenticated: true }, raw, { from: { address: body.from || this.get('sender') }, to: [{ address: body.to }], subject: body.subject, text: body.text, inReplyTo: body.inReplyTo, messageId: result.messageId }); this.sql.exec("UPDATE messages SET folder='Sent',format='json',unread=0 WHERE id=?", row.id);
           }
           this.sql.exec('UPDATE drafts SET status=?,result=? WHERE id=?', result.status, JSON.stringify(result), row.id);
           });
          return json(result, response.status);
        } catch (error) {
          // A lost response never causes a fresh send; the same draft keeps its idempotency key.
           if (row.status === 'draft' && [400, 401, 403, 413, 429].includes(error.status)) { const result = { status: 'rejected', message: error.message }; this.sql.exec("UPDATE drafts SET status='rejected',result=? WHERE id=?", JSON.stringify(result), row.id); return json(result); }
          else this.sql.exec("UPDATE drafts SET status='unknown' WHERE id=? AND status='pending'", row.id);
          throw error;
        } finally { this.sending.delete(row.id); }
      }
      throw fail('Unsupported draft operation.', 405);
    }
    throw fail('Not found.', 404);
  }
  async fetch(request) { try { return await this.handle(request); } catch (error) { return json({ error: error.status ? error.message : 'The mailbox request could not be completed.' }, error.status || 500); } }
}

const application = {
  async scheduled(_event, env, ctx) { if (!isPreview(env)) ctx.waitUntil(env.MAILBOX.get(env.MAILBOX.idFromName('inbox')).sync().catch(() => {})); },
  async email(message, env) {
    if (isPreview(env) || env.EMAIL_PROVIDER !== 'cloudflare') { message.setReject('This inbox does not receive live Cloudflare mail.'); return; }
    try {
      const address = message.to.toLowerCase();
      if (!directAddresses(env).includes(address)) throw fail('Unknown receiving address.', 404);
      if (message.rawSize > MAX_MAIL || message.rawSize <= 0) throw fail('Email must fit within 5 MiB.', 413);
      const raw = await bytes({ body: message.raw }, MAX_MAIL);
      await env.MAILBOX.get(env.MAILBOX.idFromName('inbox')).receive(raw, address, message.from);
    } catch (error) { message.setReject(error.status ? error.message : 'Mailbox storage is unavailable. Retry later.'); }
  },
  async fetch(request, env) {
    if (isPreview(env)) return previewResponse(request, env);
    try {
      const user = await accessUser(request, env), path = new URL(request.url).pathname;
      if (path === '/api/me') return json(user);
      if (path.startsWith('/api/')) return env.MAILBOX.get(env.MAILBOX.idFromName('inbox')).fetch(request);
      const response = await env.ASSETS.fetch(request), headers = new Headers(response.headers);
      headers.set('cache-control', 'private, no-store'); headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'no-referrer');
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) { return accessFailure(error); }
  },
};
export default application;

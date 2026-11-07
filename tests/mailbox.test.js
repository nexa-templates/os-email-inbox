import { test, expect, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
mock.module('cloudflare:workers', () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { Mailbox, default: worker } = await import('../src/worker.js');
const { outgoingMessage } = await import('../src/mail.js');
const address = 'org+accounting@mail.test', installation = 'a'.repeat(32);
function setup(extra = {}) {
  const db = new Database(':memory:');
  const sql = { exec(query, ...args) { if (!args.length && query.includes(';')) { db.exec(query); return; } const result = db.query(query).all(...args); return { toArray: () => result, one: () => result[0] }; } };
  const env = { EMAIL_PROVIDER: 'nexa', NEXA_SERVICE_ORIGIN: 'https://nexa.test', NEXA_SERVICE_KEY: 'fixture-key', NEXA_INSTALLATION_ID: installation, ...extra };
  const box = new Mailbox({ storage: { sql, transactionSync: fn => db.transaction(fn)() } }, env);
  const call = (path, body, method) => box.fetch(new Request('https://inbox.test/api' + path, { method: method || (body ? 'POST' : 'GET'), body: body ? JSON.stringify(body) : undefined }));
  return { db, box, env, call };
}
test('Preview cannot access real mail or cron, and unconfigured production fails closed', async () => {
  const network = spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('Preview used the network'); });
  const env = { PREVIEW_MODE: 'true', NEXA_SERVICE_KEY: 'fixture', MAILBOX: new Proxy({}, { get() { throw Error('Real mailbox accessed'); } }), ASSETS: { fetch: async () => new Response('preview') } };
  try {
    expect((await worker.fetch(new Request('https://preview.test/'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://preview.test/api/messages'), env)).status).toBe(403);
    await worker.scheduled({}, env, { waitUntil() { throw Error('Preview cron ran'); } });
    expect(network).not.toHaveBeenCalled();
    expect((await worker.fetch(new Request('https://preview.test/?preview=true'), { PREVIEW_MODE: 'false' })).status).toBe(503);
  } finally { network.mockRestore(); }
});
test('Nexa queue is installation scoped and MIME is saved before acknowledgement, including retries', async () => {
  const f = setup(), id = 'b'.repeat(32), raw = 'From: sender@mail.test\r\nTo: ' + address + '\r\nSubject: Invoice\r\nMessage-ID: <invoice@mail.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nInvoice text\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="invoice.txt"\r\n\r\nfile\r\n--x--\r\n';
  let acks = 0;
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new Headers(init.headers).get('x-nexa-installation')).toBe(installation);
    const path = new URL(url).pathname;
    if (path === '/v1/email/incoming') return Response.json({ messages: [{ id, alias: 'accounting', sender: 'sender@mail.test', received_at: Date.now() }] });
    if (path === '/v1/email/config') return Response.json({ addresses: [address] });
    if (path.endsWith('/ack')) { expect(f.db.query('SELECT COUNT(*) AS n FROM messages').get().n).toBe(1); acks++; if (acks === 1) throw Error('network'); return Response.json({ acknowledged: true }); }
    return new Response(raw);
  });
  try {
    await expect(f.box.sync()).rejects.toThrow('network'); await f.box.sync();
    const list = await (await f.call('/messages')).json(); expect(list.messages).toHaveLength(1); expect(list.addresses).toEqual([address]); expect(acks).toBe(2);
    const detail = await (await f.call('/messages/' + id)).json(); expect(detail.text).toContain('Invoice text'); expect(detail.attachments[0].filename).toBe('invoice.txt');
    expect(await (await f.call('/messages/' + id + '/attachment/0')).text()).toContain('file');
    expect((await f.call('/messages/' + id, undefined, 'DELETE')).status).toBe(400);
    await f.call('/messages/' + id, { folder: 'Trash' }, 'PATCH'); expect((await f.call('/messages/' + id, undefined, 'DELETE')).status).toBe(200);
  } finally { fetcher.mockRestore(); f.db.close(); }
});
test('Direct Cloudflare inbound mail persists before delivery returns, deduplicates, and rejects other addresses', async () => {
  const f = setup({ EMAIL_PROVIDER: 'cloudflare', EMAIL_ADDRESSES: address }), bytes = new TextEncoder().encode('From: sender@mail.test\r\nTo: ' + address + '\r\nSubject: Direct\r\n\r\nBody');
  let rejected = '', received = 0;
  const env = { ...f.env, MAILBOX: { idFromName: name => name, get: () => ({ receive: async (...args) => { await f.box.receive(...args); received++; expect(f.db.query('SELECT count(*) n FROM messages').get().n).toBe(1); } }) } };
  const deliver = to => worker.email({ to, from: 'sender@mail.test', rawSize: bytes.length, raw: new Blob([bytes]).stream(), setReject: value => { rejected = value; } }, env);
  try { await deliver(address); await deliver(address); expect(rejected).toBe(''); expect(received).toBe(2); expect(f.db.query('SELECT count(*) n FROM messages').get().n).toBe(1); await deliver('other@mail.test'); expect(rejected).not.toBe(''); expect(received).toBe(2); }
  finally { f.db.close(); }
});
test('Unknown direct sends cannot be repeated or edited; confirmed sends preserve exports', async () => {
  let calls = 0, uncertain = true;
  const f = setup({ EMAIL_PROVIDER: 'cloudflare', EMAIL_ADDRESSES: address, EMAIL: { send: async data => { calls++; expect(data.from.email).toBe(address); if (uncertain) throw Error('lost response'); return { messageId: '<sent@mail.test>' }; } } });
  const id = crypto.randomUUID(), body = { from: address, to: 'to@mail.test', subject: 'Invoice', text: 'hello' };
  try {
    expect((await f.call('/drafts/' + id, { message: body, version: 0 }, 'PUT')).status).toBe(200);
    expect((await f.call('/drafts/' + id, { message: body, version: 0 }, 'PUT')).status).toBe(409);
    expect((await (await f.call('/drafts/' + id + '/send', {})).json()).status).toBe('unknown');
    expect((await (await f.call('/drafts/' + id + '/send', {})).json()).status).toBe('unknown'); expect(calls).toBe(1);
    expect((await f.call('/drafts/' + id, undefined, 'DELETE')).status).toBe(409); expect((await f.call('/drafts/' + id, { message: body, version: 1 }, 'PUT')).status).toBe(409);
    uncertain = false; const accepted = crypto.randomUUID(); await f.call('/drafts/' + accepted, { message: body, version: 0 }, 'PUT');
    expect((await (await f.call('/drafts/' + accepted + '/send', {})).json()).status).toBe('accepted'); await f.call('/drafts/' + accepted + '/send', {}); expect(calls).toBe(2);
    const sent = await (await f.call('/messages/' + accepted)).json(); expect(sent.replyTo).toBe(body.to); expect(sent.inReplyTo).toBe('<sent@mail.test>'); expect(await (await f.call('/messages/' + accepted + '/raw')).json()).toEqual(body);
  } finally { f.db.close(); }
});
test('Full mailbox and invalid or unowned senders never reach the sending provider', async () => {
  let calls = 0; const f = setup({ EMAIL_PROVIDER: 'cloudflare', EMAIL_ADDRESSES: address, EMAIL: { send: async () => { calls++; return { messageId: '<sent@mail.test>' }; } } });
  const id = crypto.randomUUID(), body = { from: address, to: 'to@mail.test', subject: 'Invoice', text: 'hello' };
  try {
    await f.call('/drafts/' + id, { message: body, version: 0 }, 'PUT'); f.box.save({ id: 'a'.repeat(32), recipient: body.to, receivedAt: Date.now() }, new Uint8Array([1]), {}); f.db.query('UPDATE messages SET bytes=?').run(512 * 1024 * 1024);
    expect((await f.call('/drafts/' + id + '/send', {})).status).toBe(413); expect(calls).toBe(0); f.db.query('DELETE FROM messages').run();
    for (const change of [{ from: 'other@mail.test' }, { from: 1 }, { replyTo: 'other@mail.test' }, { subject: 'Header\r\nInjection' }]) expect(() => outgoingMessage({ ...body, ...change }, [address])).toThrow();
    expect(calls).toBe(0);
  } finally { f.db.close(); }
});
test('Slow draft writes cannot overwrite a newer version or alter an accepted send', async () => {
  const f = setup({ EMAIL_PROVIDER: 'cloudflare', EMAIL_ADDRESSES: address, EMAIL: { send: async () => ({ messageId: '<sent@mail.test>' }) } }), id = crypto.randomUUID(), body = { from: address, to: 'to@mail.test', subject: 'First', text: 'hello' }; let stream;
  try {
    await f.call('/drafts/' + id, { message: body, version: 0 }, 'PUT');
    const slow = () => f.box.fetch(new Request('https://inbox.test/api/drafts/' + id, { method: 'PUT', body: new ReadableStream({ start(controller) { stream = controller; } }), duplex: 'half' }));
    const pending = slow(); await f.call('/drafts/' + id, { message: { ...body, subject: 'Newer' }, version: 1 }, 'PUT'); stream.enqueue(new TextEncoder().encode(JSON.stringify({ message: body, version: 1 }))); stream.close(); expect((await pending).status).toBe(409);
    const sending = slow(); expect((await (await f.call('/drafts/' + id + '/send', {})).json()).status).toBe('accepted'); stream.enqueue(new TextEncoder().encode(JSON.stringify({ message: body, version: 2 }))); stream.close(); expect((await sending).status).toBe(409);
    expect((await (await f.call('/messages/' + id)).json()).subject).toBe('Newer');
  } finally { f.db.close(); }
});

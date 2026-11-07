import { createMimeMessage } from 'mimetext/browser';

const base64 = bytes => {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
};
const utf8 = value => new TextEncoder().encode(value);
const wrap = value => value.match(/.{1,76}/g)?.join('\r\n') || '';
const encodedWords = value => {
  const chars = Array.from(value), words = [];
  for (let offset = 0; offset < chars.length; offset += 10) words.push('=?utf-8?B?' + base64(utf8(chars.slice(offset, offset + 10).join(''))) + '?=');
  return words.join('\r\n ');
};

// Called only with messages validated by outgoingMessage or the service API.
// Structured Cloudflare attachments can use 7bit encoding and rewrite LF bytes.
export function rawMessage(message) {
  const mime = createMimeMessage(), from = typeof message.from === 'string' ? { email: message.from } : message.from;
  mime.setSender({ addr: from.email, name: from.name }); mime.setRecipient(message.to); mime.setSubject(message.subject);
  if (message.replyTo) mime.setHeader('Reply-To', mime.setSender({ addr: message.replyTo }));
  mime.setSender({ addr: from.email, name: from.name });
  for (const [name, value] of Object.entries(message.headers || {})) mime.setHeader(name, value.replace(/ (?=<)/g, '\r\n '));
  for (const [field, contentType] of [['text', 'text/plain'], ['html', 'text/html']]) if (message[field] !== undefined) mime.addMessage({ contentType, encoding: 'base64', data: wrap(base64(utf8(message[field]))) });
  for (const file of message.attachments || []) {
    const content = typeof file.content === 'string' ? file.content : base64(new Uint8Array(file.content.buffer || file.content, file.content.byteOffset || 0, file.content.byteLength));
    const part = mime.addAttachment({ filename: 'attachment', contentType: file.type, encoding: 'base64', data: wrap(content) });
    // RFC 2231 preserves Unicode and quoted filenames without header injection.
    const bytes = utf8(file.filename), parameters = [];
    for (let offset = 0; offset < bytes.length; offset += 15) parameters.push('filename*' + parameters.length + '*=' + (offset ? '' : "UTF-8''") + Array.from(bytes.subarray(offset, offset + 15), byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
    part.setHeader('Content-Type', file.type);
    part.setHeader('Content-Disposition', 'attachment;\r\n ' + parameters.join(';\r\n '));
  }
  // Fold encoded headers on character boundaries, within RFC 2047's word limit.
  return mime.asRaw().replace(/^Subject: [^\r\n]*/m, 'Subject: ' + encodedWords(message.subject)).replace(/^From: [^\r\n]*/m, from.name ? 'From: ' + encodedWords(from.name) + '\r\n <' + from.email + '>' : 'From: <' + from.email + '>');
}
export async function sendMessage(binding, message) {
  if (!message.attachments?.length) return binding.send(message);
  const { EmailMessage } = await import('cloudflare:email');
  const from = typeof message.from === 'string' ? message.from : message.from.email;
  return binding.send(new EmailMessage(from, message.to, rawMessage(message)));
}

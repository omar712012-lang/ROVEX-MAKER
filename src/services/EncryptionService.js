'use strict';

const crypto = require('node:crypto');

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is required to store bot tokens.');
  let key;
  try {
    key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  } catch {
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters.');
  }
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) throw new TypeError('Token is required.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext.trim(), 'utf8'), cipher.final()]);
  return { encrypted: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decrypt(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encrypted, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };

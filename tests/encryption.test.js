'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { encrypt, decrypt } = require('../src/services/EncryptionService');

test('AES-256-GCM token encryption round-trips', () => {
  const token = 'example-discord-bot-token-value-that-must-not-be-stored-in-plain-text';
  const record = encrypt(token);
  assert.notEqual(record.encrypted, token);
  assert.equal(decrypt(record), token);
});

test('AES-256-GCM detects ciphertext tampering', () => {
  const record = encrypt('a confidential test token');
  const bytes = Buffer.from(record.encrypted, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => decrypt({ ...record, encrypted: bytes.toString('base64') }));
});

test('encryption rejects an empty token', () => {
  assert.throws(() => encrypt('  '), /Token is required/);
});

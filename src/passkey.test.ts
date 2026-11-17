import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { SoftwarePasskey } from './passkey';

// Checks the software authenticator against WebAuthn's signature rule without Juice Shop, whose
// login-verify accepts bad signatures (a known bug) and so can't prove these are valid.
const signatureVerifies = (passkey: SoftwarePasskey, a: ReturnType<SoftwarePasskey['assertion']>) => {
  const authData = Buffer.from(a.response.authenticatorData, 'base64url');
  const clientHash = createHash('sha256').update(Buffer.from(a.response.clientDataJSON, 'base64url')).digest();
  return verify('sha256', Buffer.concat([authData, clientHash]), passkey.publicKey, Buffer.from(a.response.signature, 'base64url'));
};

test('an assertion is signed by the passkey\'s own key', () => {
  // Arrange
  const passkey = new SoftwarePasskey();

  // Act
  const assertion = passkey.assertion('challenge-1');

  // Assert
  assert.equal(signatureVerifies(passkey, assertion), true);
});

test('an assertion signed by another key does not verify', () => {
  const passkey = new SoftwarePasskey();
  assert.equal(signatureVerifies(passkey, passkey.assertion('challenge-1', { signedBy: 'another key' })), false);
});

test('client data carries the challenge and the app origin', () => {
  const clientData = JSON.parse(Buffer.from(new SoftwarePasskey().assertion('challenge-2').response.clientDataJSON, 'base64url').toString());
  assert.deepEqual(clientData, { type: 'webauthn.get', challenge: 'challenge-2', origin: 'http://localhost:3000', crossOrigin: false });
});

test('the sign count goes up with every assertion', () => {
  const passkey = new SoftwarePasskey();
  const count = (a: ReturnType<SoftwarePasskey['assertion']>) => Buffer.from(a.response.authenticatorData, 'base64url').readUInt32BE(33);
  assert.deepEqual([count(passkey.assertion('a')), count(passkey.assertion('b'))], [1, 2]);
});

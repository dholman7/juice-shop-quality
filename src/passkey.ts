/**
 * Software passkey authenticator for API tests. It holds a real P-256 key pair and builds the same
 * registration and sign-in payloads a browser sends, so Juice Shop's own WebAuthn verification runs
 * end to end. Only the hardware is simulated; nothing on the server side is mocked.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Api } from './api';
import { BASE_URL } from './config';

// Juice Shop derives the relying party from the request: rpID is the hostname, origin is protocol://host.
const RP = { id: new URL(BASE_URL).hostname, origin: new URL(BASE_URL).origin };

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64url = (data: Buffer) => data.toString('base64url');

/** Minimal CBOR encoder: enough for a COSE public key and a "none" attestation object. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n])
      : n < 256 ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error(`cbor: unsupported value ${String(value)}`);
}

const clientData = (type: 'webauthn.create' | 'webauthn.get', challenge: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin: RP.origin, crossOrigin: false }));

const USER_PRESENT = 0x01;
const ATTESTED_CREDENTIAL = 0x40;

export class SoftwarePasskey {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;

  /** Pass an existing credential id to impersonate someone else's passkey (hijack tests). */
  constructor(readonly rawId: Buffer = randomBytes(16)) {}

  /** For unit tests that check the signatures independently of Juice Shop. */
  get publicKey(): KeyObject {
    return this.keys.publicKey;
  }

  get id(): string {
    return b64url(this.rawId);
  }

  /** What navigator.credentials.create() returns for a registration challenge. */
  attestation(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    // COSE key: kty EC2, alg ES256, crv P-256, x, y.
    const coseKey = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.rawId.length);
    const authData = Buffer.concat([
      sha256(RP.id), Buffer.from([USER_PRESENT | ATTESTED_CREDENTIAL]), Buffer.alloc(4), // rpIdHash, flags, sign count
      Buffer.alloc(16), idLength, this.rawId, coseKey, // AAGUID (none), credential id, public key
    ]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientData('webauthn.create', challenge)), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  /**
   * What navigator.credentials.get() returns for a sign-in challenge.
   * `signedBy: 'another key'` signs with a fresh key pair: a well-formed signature that must not verify.
   */
  assertion(challenge: string, { signedBy = 'this key' }: { signedBy?: 'this key' | 'another key' } = {}) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(RP.id), Buffer.from([USER_PRESENT]), count]);
    const json = clientData('webauthn.get', challenge);
    const key = signedBy === 'this key' ? this.keys.privateKey : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const signature = sign('sha256', Buffer.concat([authData, sha256(json)]), key);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(json), authenticatorData: b64url(authData), signature: b64url(signature) },
      clientExtensionResults: {},
    };
  }
}

/** The register-verify request body for a new passkey on `owner`'s account. */
export async function registrationBody(owner: Api, passkey = new SoftwarePasskey()) {
  const { options, regToken } = await (await owner.get('/rest/passkey/register-options')).json();
  return { attestation: passkey.attestation(options.challenge), regToken };
}

/** Registers a new software passkey on the account and returns it. Throws if Juice Shop refuses. */
export async function registerPasskey(owner: Api, passkey = new SoftwarePasskey()): Promise<SoftwarePasskey> {
  const res = await owner.post('/rest/passkey/register-verify', await registrationBody(owner, passkey));
  if (!res.ok()) throw new Error(`passkey registration failed: ${res.status()} ${await res.text()}`);
  return passkey;
}

/** The login-verify request body for `passkey`, from a fresh sign-in challenge. */
export async function signInBody(api: Api, passkey: SoftwarePasskey, signedBy: 'this key' | 'another key' = 'this key') {
  const { options, authToken } = await (await api.post('/rest/passkey/login-options', {})).json();
  return { assertion: passkey.assertion(options.challenge, { signedBy }), authToken };
}

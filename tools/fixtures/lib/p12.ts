/**
 * Deterministic PKCS#12 (RFC 7292) writer and reader for the test PKI
 * (test/fixtures/pki/*.p12). Salts and IVs are derived from a seed instead of
 * drawn at random, so the files are byte-reproducible; that makes them
 * predictable, which is fine for test-only keys and nothing else.
 *
 * Two layouts, as OpenSSL writes them:
 * - `pbes2`: OpenSSL 3 default. Key bag and certificate bags encrypted with
 *   PBES2 (PBKDF2-HMAC-SHA256, AES-256-CBC), MAC HMAC-SHA256. pkijs reads this.
 * - `legacy-3des`: pbeWithSHAAnd3-KeyTripleDES-CBC for both bags, MAC
 *   HMAC-SHA1 (what `openssl pkcs12 -legacy` minus RC2, or older Windows,
 *   writes). pkijs cannot decrypt it; the product must refuse it (spec §3.2).
 */
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
} from 'node:crypto';
import {
  type Tlv,
  child,
  children,
  compareBytes,
  ctx,
  int,
  nul,
  octets,
  oid,
  readOid,
  readTlv,
  seq,
  setOf,
  tlv,
} from './der.ts';

const P12 = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.2', // pkcs8ShroudedKeyBag
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacWithSHA256: '1.2.840.113549.2.9',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  sha3DesCbc: '1.2.840.113549.1.12.1.3',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
} as const;

export type P12Scheme = 'pbes2' | 'legacy-3des';

export interface P12Input {
  password: string;
  key: KeyObject;
  /** DER certificates, the key's own certificate first. */
  certs: Uint8Array[];
  friendlyName: string;
  scheme: P12Scheme;
  /** Seed for the salts and IVs. */
  seed: string;
  iterations?: number;
}

/** Password as a NUL-terminated BMPString (RFC 7292 B.1). */
function bmpPassword(password: string): Uint8Array {
  const out = new Uint8Array((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    const code = password.charCodeAt(i);
    out[2 * i] = code >> 8;
    out[2 * i + 1] = code & 0xff;
  }
  return out;
}

/** RFC 7292 Appendix B.2 key derivation (id 1: key, 2: IV, 3: MAC key). */
export function p12Kdf(
  hash: 'sha1' | 'sha256',
  password: string,
  salt: Uint8Array,
  id: 1 | 2 | 3,
  iterations: number,
  length: number,
): Uint8Array {
  const u = hash === 'sha1' ? 20 : 32;
  const v = 64;
  const fill = (src: Uint8Array) => {
    const len = src.length ? v * Math.ceil(src.length / v) : 0;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = src[i % src.length] ?? 0;
    return out;
  };
  const d = new Uint8Array(v).fill(id);
  const i = new Uint8Array([...fill(salt), ...fill(bmpPassword(password))]);
  const out = new Uint8Array(Math.ceil(length / u) * u);
  for (let block = 0; block * u < length; block++) {
    let a = new Uint8Array(createHash(hash).update(d).update(i).digest());
    for (let r = 1; r < iterations; r++) a = new Uint8Array(createHash(hash).update(a).digest());
    out.set(a, block * u);
    const b = new Uint8Array(v);
    for (let k = 0; k < v; k++) b[k] = a[k % u] ?? 0;
    for (let j = 0; j < i.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = (i[j + k] ?? 0) + (b[k] ?? 0) + carry;
        i[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return out.subarray(0, length);
}

function seeded(seed: string, label: string, length: number): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${seed}#${label}`).digest()).subarray(
    0,
    length,
  );
}

interface Encryption {
  algorithm: Uint8Array;
  encrypt: (plain: Uint8Array) => Uint8Array;
}

function encryption(input: P12Input, label: string): Encryption {
  const iterations = input.iterations ?? 2048;
  if (input.scheme === 'legacy-3des') {
    const salt = seeded(input.seed, `${label}-salt`, 8);
    const key = p12Kdf('sha1', input.password, salt, 1, iterations, 24);
    const iv = p12Kdf('sha1', input.password, salt, 2, iterations, 8);
    return {
      algorithm: seq(oid(P12.sha3DesCbc), seq(octets(salt), int(iterations))),
      encrypt: (plain) => cipher('des-ede3-cbc', key, iv, plain),
    };
  }
  const salt = seeded(input.seed, `${label}-salt`, 16);
  const iv = seeded(input.seed, `${label}-iv`, 16);
  const key = new Uint8Array(
    pbkdf2Sync(Buffer.from(input.password, 'utf8'), salt, iterations, 32, 'sha256'),
  );
  return {
    algorithm: seq(
      oid(P12.pbes2),
      seq(
        seq(
          oid(P12.pbkdf2),
          seq(octets(salt), int(iterations), seq(oid(P12.hmacWithSHA256), nul())),
        ),
        seq(oid(P12.aes256Cbc), octets(iv)),
      ),
    ),
    encrypt: (plain) => cipher('aes-256-cbc', key, iv, plain),
  };
}

function cipher(name: string, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv(name, key, iv);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

function bmpString(text: string): Uint8Array {
  return tlv(0x1e, bmpPassword(text).subarray(0, text.length * 2));
}

export function buildP12(input: P12Input): Uint8Array {
  const [own, ...others] = input.certs;
  if (!own) throw new Error('buildP12: no certificate');
  const localKeyId = new Uint8Array(createHash('sha1').update(own).digest());
  const attrs = setOf(
    seq(oid(P12.friendlyName), setOf(bmpString(input.friendlyName))),
    seq(oid(P12.localKeyId), setOf(octets(localKeyId))),
  );
  const certBag = (der: Uint8Array, withAttrs: boolean) =>
    seq(
      oid(P12.certBag),
      ctx(0, seq(oid(P12.x509Certificate), ctx(0, octets(der)))),
      ...(withAttrs ? [attrs] : []),
    );
  const certContents = seq(certBag(own, true), ...others.map((c) => certBag(c, false)));
  const certEnc = encryption(input, 'certs');
  const certInfo = seq(
    oid(P12.encryptedData),
    ctx(
      0,
      seq(int(0), seq(oid(P12.data), certEnc.algorithm, tlv(0x80, certEnc.encrypt(certContents)))),
    ),
  );

  const pkcs8 = new Uint8Array(input.key.export({ type: 'pkcs8', format: 'der' }));
  const keyEnc = encryption(input, 'key');
  const keyContents = seq(
    seq(oid(P12.keyBag), ctx(0, seq(keyEnc.algorithm, octets(keyEnc.encrypt(pkcs8)))), attrs),
  );
  const keyInfo = seq(oid(P12.data), ctx(0, octets(keyContents)));

  const authSafe = seq(certInfo, keyInfo);
  const legacy = input.scheme === 'legacy-3des';
  const hash = legacy ? 'sha1' : 'sha256';
  const iterations = input.iterations ?? 2048;
  const macSalt = seeded(input.seed, 'mac-salt', legacy ? 8 : 16);
  const macKey = p12Kdf(hash, input.password, macSalt, 3, iterations, legacy ? 20 : 32);
  const mac = new Uint8Array(createHmac(hash, macKey).update(authSafe).digest());
  return seq(
    int(3),
    seq(oid(P12.data), ctx(0, octets(authSafe))),
    seq(
      seq(seq(oid(legacy ? P12.sha1 : P12.sha256), nul()), octets(mac)),
      octets(macSalt),
      int(iterations),
    ),
  );
}

// ---------------------------------------------------------------------------
// Reader (verify.ts): MAC check and decryption of every bag
// ---------------------------------------------------------------------------

export interface P12Contents {
  scheme: P12Scheme;
  macAlgorithm: 'SHA-1' | 'SHA-256';
  macValid: boolean;
  iterations: number;
  /** PKCS#8 DER of the key. */
  key: Uint8Array;
  certs: Uint8Array[];
  friendlyName: string;
}

const readInt = (node: Tlv) => node.content.reduce((n, b) => n * 256 + b, 0);

function decrypt(
  algorithm: Tlv,
  password: string,
  data: Uint8Array,
): { plain: Uint8Array; scheme: P12Scheme } {
  const id = readOid(child(algorithm, 0));
  const params = child(algorithm, 1);
  if (id === P12.sha3DesCbc) {
    const salt = child(params, 0).content;
    const iterations = readInt(child(params, 1));
    const key = p12Kdf('sha1', password, salt, 1, iterations, 24);
    const iv = p12Kdf('sha1', password, salt, 2, iterations, 8);
    const d = createDecipheriv('des-ede3-cbc', key, iv);
    return {
      plain: new Uint8Array(Buffer.concat([d.update(data), d.final()])),
      scheme: 'legacy-3des',
    };
  }
  if (id !== P12.pbes2) throw new Error(`unsupported PBE ${id}`);
  const kdf = child(child(params, 0), 1);
  const salt = child(kdf, 0).content;
  const iterations = readInt(child(kdf, 1));
  const iv = child(child(params, 1), 1).content;
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const d = createDecipheriv('aes-256-cbc', key, iv);
  return { plain: new Uint8Array(Buffer.concat([d.update(data), d.final()])), scheme: 'pbes2' };
}

export function readP12(der: Uint8Array, password: string): P12Contents {
  const pfx = readTlv(der);
  const [, authSafeInfo, macData] = children(pfx);
  if (!authSafeInfo || !macData) throw new Error('PFX incomplete');
  const authSafe = child(child(authSafeInfo, 1), 0).content;
  const digestInfo = child(macData, 0);
  const macOid = readOid(child(child(digestInfo, 0), 0));
  const hash = macOid === P12.sha1 ? 'sha1' : 'sha256';
  const macSalt = child(macData, 1).content;
  const iterations = readInt(child(macData, 2));
  const macKey = p12Kdf(hash, password, macSalt, 3, iterations, hash === 'sha1' ? 20 : 32);
  const mac = createHmac(hash, macKey).update(authSafe).digest();
  const macValid = compareBytes(new Uint8Array(mac), child(digestInfo, 1).content) === 0;
  if (!macValid) throw new Error('PKCS#12 MAC verification failed (wrong password?)');

  let key: Uint8Array | undefined;
  let scheme: P12Scheme | undefined;
  let friendlyName = '';
  const certs: Uint8Array[] = [];
  for (const info of children(readTlv(authSafe))) {
    const type = readOid(child(info, 0));
    let safeContents: Uint8Array;
    if (type === P12.data) {
      safeContents = child(child(info, 1), 0).content;
    } else {
      const eci = child(child(child(info, 1), 0), 1);
      const r = decrypt(child(eci, 1), password, child(eci, 2).content);
      safeContents = r.plain;
      scheme = r.scheme;
    }
    for (const bag of children(readTlv(safeContents))) {
      const bagId = readOid(child(bag, 0));
      const value = child(child(bag, 1), 0);
      const bagAttrs = children(bag)[2];
      for (const attr of bagAttrs ? children(bagAttrs) : []) {
        if (readOid(child(attr, 0)) === P12.friendlyName) {
          const raw = child(child(attr, 1), 0).content;
          friendlyName = String.fromCharCode(
            ...Array.from(
              { length: raw.length / 2 },
              (_, i) => ((raw[2 * i] ?? 0) << 8) | (raw[2 * i + 1] ?? 0),
            ),
          );
        }
      }
      if (bagId === P12.certBag) certs.push(child(child(value, 1), 0).content);
      if (bagId === P12.keyBag) {
        const r = decrypt(child(value, 0), password, child(value, 1).content);
        key = r.plain;
        scheme ??= r.scheme;
      }
    }
  }
  if (!key || !scheme) throw new Error('PKCS#12 without a key bag');
  return {
    scheme,
    macAlgorithm: hash === 'sha1' ? 'SHA-1' : 'SHA-256',
    macValid,
    iterations,
    key,
    certs,
    friendlyName,
  };
}

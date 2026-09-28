/**
 * Test-only PKI made with the system `openssl` (root → intermediate → RSA-2048 and P-256
 * signers) and PKCS#12 files in the export flavours S2 must handle. Written under
 * test-results/pki (git-ignored); every run regenerates it. Nothing here is secret.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS = fileURLToPath(new URL('../../test-results/', import.meta.url));
export const PKI = join(RESULTS, 'pki');
export const PASSWORD = 'spike-password';
export const TURKISH_PASSWORD = 'şifre-İĞ-ü';

export function openssl(args: string[], input?: Uint8Array): string {
  return execFileSync('openssl', args, {
    cwd: PKI,
    ...(input === undefined ? {} : { input }),
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString('latin1');
}

/** Runs openssl and returns exit status and combined output instead of throwing. */
export function opensslStatus(args: string[]): { ok: boolean; output: string } {
  const r = spawnSync('openssl', args, { cwd: PKI });
  return { ok: r.status === 0, output: `${r.stdout.toString()}${r.stderr.toString()}` };
}

export interface Pkcs12Case {
  readonly file: string;
  readonly label: string;
  readonly password: string;
  readonly args: string[];
}

export const PKCS12_CASES: readonly Pkcs12Case[] = [
  {
    file: 'rsa-openssl3-default.p12',
    label: 'RSA, OpenSSL 3 default export',
    password: PASSWORD,
    args: [],
  },
  {
    file: 'rsa-aes256-sha256.p12',
    label: 'RSA, Windows "AES256-SHA256" flags',
    password: PASSWORD,
    args: ['-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'SHA256'],
  },
  {
    file: 'ec-openssl3-default.p12',
    label: 'ECDSA P-256, OpenSSL 3 default',
    password: PASSWORD,
    args: [],
  },
  {
    file: 'rsa-certs-unencrypted.p12',
    label: 'RSA, certificates unencrypted (-certpbe NONE)',
    password: PASSWORD,
    args: ['-certpbe', 'NONE'],
  },
  {
    file: 'rsa-turkish-password.p12',
    label: 'RSA, OpenSSL 3 default, non-ASCII password',
    password: TURKISH_PASSWORD,
    args: [],
  },
  {
    file: 'rsa-legacy-3des.p12',
    label: 'RSA, legacy 3DES (PBE-SHA1-3DES, SHA-1 MAC)',
    password: PASSWORD,
    args: ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'SHA1'],
  },
  {
    file: 'rsa-legacy-rc2.p12',
    label: 'RSA, OpenSSL -legacy (RC2-40 certs, 3DES key)',
    password: PASSWORD,
    args: ['-legacy'],
  },
];

export function makePki(): void {
  mkdirSync(PKI, { recursive: true });
  writeFileSync(
    join(PKI, 'ca.ext'),
    'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n',
  );
  writeFileSync(
    join(PKI, 'leaf.ext'),
    'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n',
  );
  const subj = (cn: string) => ['-subj', `/CN=${cn}/O=pdf-editor S2 spike (test only)`];
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'root.key',
    '-out',
    'root.crt',
    ...subj('S2 Test Root'),
    '-days',
    '3650',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'inter.key',
    '-out',
    'inter.csr',
    ...subj('S2 Test Intermediate'),
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    'inter.csr',
    '-CA',
    'root.crt',
    '-CAkey',
    'root.key',
    '-CAcreateserial',
    '-out',
    'inter.crt',
    '-days',
    '3650',
    '-extfile',
    'ca.ext',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'rsa.key',
    '-out',
    'rsa.csr',
    ...subj('S2 RSA Signer'),
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    'rsa.csr',
    '-CA',
    'inter.crt',
    '-CAkey',
    'inter.key',
    '-CAcreateserial',
    '-out',
    'rsa.crt',
    '-days',
    '825',
    '-extfile',
    'leaf.ext',
  ]);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ec.key']);
  openssl(['req', '-new', '-key', 'ec.key', '-out', 'ec.csr', ...subj('S2 ECDSA Signer')]);
  openssl([
    'x509',
    '-req',
    '-in',
    'ec.csr',
    '-CA',
    'inter.crt',
    '-CAkey',
    'inter.key',
    '-CAcreateserial',
    '-out',
    'ec.crt',
    '-days',
    '825',
    '-extfile',
    'leaf.ext',
  ]);
  writeFileSync(
    join(PKI, 'chain.pem'),
    readFileSync(join(PKI, 'inter.crt'), 'latin1') + readFileSync(join(PKI, 'root.crt'), 'latin1'),
  );
  for (const c of PKCS12_CASES) {
    const leaf = c.file.startsWith('ec-') ? 'ec' : 'rsa';
    openssl([
      'pkcs12',
      '-export',
      '-inkey',
      `${leaf}.key`,
      '-in',
      `${leaf}.crt`,
      '-certfile',
      'chain.pem',
      '-name',
      'S2 signer',
      '-passout',
      `pass:${c.password}`,
      ...c.args,
      '-out',
      c.file,
    ]);
  }
}

export function readPki(file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(PKI, file)));
}

/** What `openssl pkcs12 -info` says about a file's protection (first lines only). */
export function describePkcs12(c: Pkcs12Case): string {
  const r = opensslStatus([
    'pkcs12',
    '-in',
    c.file,
    '-info',
    '-noout',
    '-passin',
    `pass:${c.password}`,
    ...(c.args.includes('-legacy') ? ['-legacy'] : []),
  ]);
  return r.output
    .split('\n')
    .filter((l) => /MAC|PBES2|PBKDF2|pbeWith|Shrouded|encrypted data/i.test(l))
    .map((l) => l.trim())
    .join('; ');
}

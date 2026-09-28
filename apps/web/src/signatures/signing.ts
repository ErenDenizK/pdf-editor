/**
 * PAdES-B approval signing in the app (spec recognize-and-compare §3.2, ADR-0013 §2).
 *
 * - `checkIdentity`: the certificate check the Sign dialog runs before export. The engine has
 *   no parse-only PKCS#12 call, so the dialog signs a one-page placeholder PDF in a worker of
 *   its own and reads the signer from the result: the signer name shows before the real
 *   signing, and refusals (legacy 3DES, wrong password, no key) come up front. The worker
 *   ends right after; only the placeholder is signed.
 * - `signExportBytes`: the last step of export, on a copy of the verified output bytes, in a
 *   dedicated worker terminated afterwards (the key goes with it).
 * - `signingFailureText`: the engine's refusal reasons in words.
 */
import type { Rect } from '@pdf-editor/document-model';
import type {
  SignatureProxy,
  SignatureReport,
  SigningFailureReason,
  SignOptions,
  SignRequest,
  SignResult,
  SignerFacts,
} from '@pdf-editor/engine';

import { getSignatureWorkers } from '../engine/engine-service';
import { m } from '../i18n';
import type { SignatureCorner } from './pdf-pass';
import { algorithmText } from './status';

/** What the user chose in the Sign dialog; the .p12 bytes stay in memory only. */
export interface SignDraft {
  readonly pkcs12: ArrayBuffer;
  readonly fileName: string;
  readonly password: string;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  /** A visible signature on this output page (0-based) at this corner; invisible when absent. */
  readonly visible?: { readonly pageIndex: number; readonly corner: SignatureCorner };
  /** The signer as the certificate check read it. */
  readonly signer: SignerFacts;
}

/** The signature line of the export summary (spec §3.2: the summary records it). */
export interface SignatureExportSummary {
  readonly signer: string;
  readonly algorithm: string;
  readonly fieldName: string;
  readonly report: SignatureReport;
}

/** The engine's `SigningError` duck-typed (it crosses the worker as a value). */
export function signingReason(error: unknown): SigningFailureReason | undefined {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? (reason as SigningFailureReason) : undefined;
}

/** A refusal or failure in words; `legacy-pkcs12` also shows the re-export command. */
export function signingFailureText(error: unknown): string {
  const reason = signingReason(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (reason) {
    case 'legacy-pkcs12':
      return m.sign_refused_legacy();
    case 'bad-password':
      return m.sign_refused_password();
    case 'malformed-pkcs12':
      return m.sign_refused_malformed();
    case 'no-key':
      return m.sign_refused_no_key();
    case 'unsupported-key':
      return m.sign_refused_unsupported_key();
    case 'encrypted-input':
      return m.sign_refused_encrypted();
    case 'damaged-input':
      return m.sign_refused_damaged();
    case 'field-exists':
    case 'bad-request':
    case 'reserve-too-small':
    case 'verification-failed':
    case undefined:
      return m.sign_failed({ reason: message });
  }
}

/** A minimal one-page PDF (classic xref) for the certificate check. */
export function placeholderPdf(): ArrayBuffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body).buffer;
}

type SignerProxy = Pick<SignatureProxy, 'signPdf' | 'terminate'>;

export interface SigningDependencies {
  /** A fresh signature worker for one signing; terminated by the caller. */
  readonly worker: () => Promise<SignerProxy>;
}

const defaultSigning = (): SigningDependencies => ({
  worker: () => getSignatureWorkers().dedicated(),
});

/**
 * Opens the .p12 with its password by signing the placeholder PDF: resolves to the signer,
 * or rejects with the engine's `SigningError` (see `signingFailureText`). `pkcs12` is copied.
 */
export async function checkIdentity(
  pkcs12: ArrayBuffer,
  password: string,
  deps: SigningDependencies = defaultSigning(),
): Promise<SignerFacts> {
  const proxy = await deps.worker();
  try {
    const result = await proxy.signPdf(placeholderPdf(), {
      pkcs12: pkcs12.slice(0),
      password,
      reason: 'Certificate check',
    });
    return result.signer;
  } finally {
    proxy.terminate();
  }
}

/** The engine request for a draft (a copy of the .p12; `rect` for a visible signature). */
export function signRequestOf(draft: SignDraft, rect?: Rect): SignRequest {
  const text = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const reason = text(draft.reason);
  const location = text(draft.location);
  const contactInfo = text(draft.contactInfo);
  return {
    pkcs12: draft.pkcs12.slice(0),
    password: draft.password,
    ...(reason ? { reason } : {}),
    ...(location ? { location } : {}),
    ...(contactInfo ? { contactInfo } : {}),
    ...(draft.visible && rect ? { visible: { pageIndex: draft.visible.pageIndex, rect } } : {}),
  };
}

/**
 * Signs a copy of `bytes` in a dedicated worker and terminates it (always). Rejects with the
 * engine's error on a refusal.
 */
export async function signExportBytes(
  bytes: ArrayBuffer,
  request: SignRequest,
  options: SignOptions = {},
  deps: SigningDependencies = defaultSigning(),
): Promise<SignResult> {
  const proxy = await deps.worker();
  try {
    return await proxy.signPdf(bytes.slice(0), request, options);
  } finally {
    proxy.terminate();
  }
}

export function signatureSummaryOf(result: SignResult): SignatureExportSummary {
  return {
    signer: result.signer.commonName ?? result.signer.subject,
    algorithm: algorithmText(result.report),
    fieldName: result.fieldName,
    report: result.report,
  };
}

/**
 * Digital signatures (M5, spec recognize-and-compare §3, ADR-0013): the offline validator,
 * the revision classifier and PAdES-B approval signing. In the app these run in the signature
 * worker (`@pdf-editor/engine/signature.worker`, `createSignatureProxy`); private keys exist
 * only inside that worker.
 */
export { revisionBytes, validateSignatures } from './validate';
export { DEFAULT_RESERVE_BYTES, signPdf } from './sign';
export { PKCS12_REEXPORT_COMMAND } from './pkcs12';
export { revisionEnds, type RevisionEnd } from './xref';

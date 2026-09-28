import { makePki } from './pki';

/** One PKI per run, shared by every node spike file. */
export default function setup(): void {
  makePki();
}

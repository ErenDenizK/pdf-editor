/**
 * Verification of a compressed copy before it is offered (ARCHITECTURE.md §4: only
 * verified bytes are delivered): the copy is re-opened in PDFium and must have the
 * source's page count, page sizes and rotations.
 */
import { getEngineService } from '../engine/engine-service';
import { openScratch } from './engine-access';

/** Problems found (empty when the copy is verified). Neither buffer is detached. */
export async function verifyCopy(source: ArrayBuffer, copy: ArrayBuffer): Promise<string[]> {
  const scratch = await openScratch(source.slice(0));
  const pages = scratch.document.pages;
  await scratch.close();
  const verified = await getEngineService().verify(copy.slice(0), {
    pageCount: pages.length,
    pageSizes: pages.map((p) => p.size),
    rotations: pages.map((p) => p.rotation),
  });
  if (!verified.ok) return [verified.error.message];
  return [...verified.value.problems];
}

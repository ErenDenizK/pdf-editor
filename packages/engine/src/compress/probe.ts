/**
 * One-page "probe" PDFs holding a single image XObject, drawn to fill a page whose size in
 * points equals the image's pixel size. PDFium decodes them (`pdfium-decoder.ts`); the
 * deep copy carries everything the image needs (colour space, ICC profile, soft mask,
 * decode parameters).
 */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  type PDFRef,
  type PDFStream,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib';

export async function buildProbe(
  source: PDFDocument,
  image: PDFStream,
  width: number,
  height: number,
  keepSoftMask: boolean,
): Promise<Uint8Array> {
  const probe = await PDFDocument.create({ updateMetadata: false });
  const copy = PDFObjectCopier.for(source.context, probe.context).copy(image);
  if (!keepSoftMask) copy.dict.delete(PDFName.of('SMask'));
  const ref: PDFRef = probe.context.register(copy);
  const page = probe.addPage([width, height]);
  page.node.setXObject(PDFName.of('Im0'), ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, 0, 0),
    drawObject('Im0'),
    popGraphicsState(),
  );
  return probe.save({ useObjectStreams: false });
}

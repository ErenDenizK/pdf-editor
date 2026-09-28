/**
 * A simple visible appearance for a signature widget: a thin frame, the signer name and the
 * claimed date in Helvetica (WinAnsi; characters it cannot show become "?"). Built as a Form
 * XObject with direct resources, so the widget and this one stream are all a visible
 * signature adds.
 */
import { PDFName, type PDFContext, type PDFRef } from '@cantoo/pdf-lib';

function winAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 63;
    out += code >= 0x20 && code <= 0x7e ? ch : code >= 0xa0 && code <= 0xff ? ch : '?';
  }
  return out;
}

function literal(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function octalLatin1(text: string): string {
  // Bytes 0xA0 to 0xFF as octal escapes, so the content stream stays 7-bit.
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code >= 0xa0 ? `\\${code.toString(8).padStart(3, '0')}` : ch;
  }
  return out;
}

export interface AppearanceText {
  readonly signer: string;
  readonly date: Date;
  readonly reason?: string;
}

function formatDate(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function signatureAppearance(
  context: PDFContext,
  width: number,
  height: number,
  text: AppearanceText,
): PDFRef {
  const lines = [
    `Digitally signed by ${winAnsi(text.signer)}`,
    `Date: ${formatDate(text.date)}`,
    ...(text.reason ? [`Reason: ${winAnsi(text.reason)}`] : []),
  ];
  const pad = Math.min(4, width / 10, height / 10);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  // Helvetica's average advance is about 0.52 em for mixed text.
  const size = Math.max(
    2,
    Math.min(10, (height - 2 * pad) / (lines.length * 1.25), (width - 2 * pad) / (longest * 0.52)),
  );
  const ops = [
    'q',
    '0.5 w 0.2 0.2 0.2 RG',
    `0.25 0.25 ${(width - 0.5).toFixed(2)} ${(height - 0.5).toFixed(2)} re S`,
    'BT',
    '0 0 0 rg',
    `/Helv ${size.toFixed(2)} Tf`,
    `${(size * 1.25).toFixed(2)} TL`,
    `${pad.toFixed(2)} ${(height - pad - size).toFixed(2)} Td`,
    ...lines.map((line, i) => `${i === 0 ? '' : 'T* '}${octalLatin1(literal(line))} Tj`),
    'ET',
    'Q',
  ];
  const stream = context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, width, height],
    Resources: {
      Font: {
        Helv: {
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
        },
      },
    },
  });
  stream.dict.set(PDFName.of('FormType'), context.obj(1));
  return context.register(stream);
}

/**
 * Paragraph-detection corpus (spec craft §4.1, §10): test/fixtures/text-edit-corpus/.
 *
 *   node --experimental-strip-types tools/fixtures/text-edit-corpus.ts
 *
 * Every text is fictional. Six pages are printed by headless Chromium ("Save as PDF",
 * which writes a tagged PDF with embedded Liberation fonts); four of them have their
 * structure tree removed afterwards (`/StructTreeRoot`, `/MarkInfo`, `/StructParents`), so
 * detection has to use geometry, as for an untagged export. The LaTeX-like page is written
 * directly with pdf-lib the way pdfTeX writes text: one `TJ` per line, no space glyphs (the
 * word gaps are `TJ` offsets), justified, hyphenated at line ends, with `fi`/`fl` ligature
 * glyphs. Chromium is found through `CHROME`, else Playwright's default install directory.
 * LibreOffice Writer is not used: the machine that built the corpus had only LibreOffice core.
 *
 * Chromium output is not byte-reproducible across versions; the dates are fixed and the files
 * are committed, so the tests do not depend on this script running.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

import { FIXED_DATE, REPO_ROOT } from './lib/common.ts';

const OUT = join(REPO_ROOT, 'test/fixtures/text-edit-corpus');
const CREATOR = 'pdf-editor fixture generator (tools/fixtures/text-edit-corpus.ts)';

function findChrome(): string {
  const fromEnv = process.env.CHROME;
  if (fromEnv) return fromEnv;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) throw new Error('Chromium not found: set CHROME');
  return join(root, dir, 'chrome-linux', 'chrome');
}

const CSS = `
@page { size: A4; margin: 2cm 2.5cm; }
html, body { margin: 0; }
body { font-family: 'Liberation Serif'; font-size: 11pt; line-height: 1.35; color: #000; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 14pt; margin: 14pt 0 6pt; }
p { margin: 0 0 8pt; }
`;

function html(body: string, extraCss = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corpus</title><style>${CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

const PAGES: Record<string, { html: string; tagged: boolean }> = {
  // A word-processor-like page: heading, two paragraphs, a list (one item wraps).
  'word-tagged.pdf': {
    tagged: true,
    html: html(`
<h1>Harbour notes</h1>
<p>The ferry left the quay at dawn, and the gulls followed it out past the breakwater, where the water turned from green to grey and the town behind it shrank to a line of roofs and chimneys under a pale sky.</p>
<p>By noon the wind had dropped. The crew ate on deck, counted the crates of apples bound for the island market, and argued in friendly voices about whether the old lighthouse keeper would come down to meet the boat this year.</p>
<ul>
<li>Check the mooring lines before every crossing.</li>
<li>Keep the logbook dry, signed and up to date, and copy each evening's entry into the second book that stays in the harbour office.</li>
<li>Report any floating timber to the harbour master.</li>
</ul>`),
  },
  // Two columns under a title that spans them.
  'two-column.pdf': {
    tagged: false,
    html: html(
      `
<h1>The orchard cooperative</h1>
<div class="cols">
<p>Every autumn the members of the orchard cooperative gather in the long barn to sort the harvest. The work begins before sunrise, when the first carts arrive from the upper slopes with crates of early pears still wet with dew.</p>
<p>Sorting is done by hand. Each fruit is turned once, checked for bruises and laid in one of three baskets: market, cider or compost. Children are allowed to help with the compost basket, which they consider the most important of the three.</p>
<p>In the afternoon the cider press runs without a pause. Its wooden screw creaks loudly enough to be heard from the road, and travellers often stop to ask whether they may taste the first jug of the season.</p>
<p>When the light fades the tables are cleared, lamps are lit and the accounts for the day are read aloud, so that everyone knows how many crates went to the market and how many barrels are waiting in the cellar.</p>
</div>`,
      '.cols { column-count: 2; column-gap: 0.8cm; text-align: justify; }',
    ),
  },
  // A figure (a filled box), its caption in a smaller italic, text before and after.
  'captions.pdf': {
    tagged: false,
    html: html(
      `
<p>The survey team mapped the valley floor during the dry months, walking the same line every morning so that changes in the river bed could be compared from one week to the next.</p>
<div class="figure"></div>
<p class="caption">Figure 1. The river bed at the northern ford, seen from the survey post on the eastern bank.</p>
<p>After the first rains the ford was no longer passable on foot, and the team moved its post two kilometres downstream, where a stone bridge offered a dry crossing and a clear view of the meanders.</p>`,
      '.figure { height: 6cm; background: #9aa7b8; margin: 10pt 0 6pt; } .caption { font-size: 9pt; font-style: italic; margin-bottom: 14pt; }',
    ),
  },
  // A centred title and a right-aligned date above the body.
  'title-date.pdf': {
    tagged: false,
    html: html(
      `
<p class="title">Minutes of the Lantern Society</p>
<p class="date">12 March 2024</p>
<p>The meeting opened with a short report on the winter lantern walk, which drew more visitors than any previous year despite the rain. The treasurer thanked the bakery on Mill Street for the loan of its trestle tables.</p>
<p>Members agreed to repaint the society's hand cart before the spring fair and to ask the town council for permission to hang lanterns along the canal path for one evening in May.</p>`,
      '.title { text-align: center; font-size: 18pt; font-weight: bold; margin-bottom: 4pt; } .date { text-align: right; margin-bottom: 16pt; }',
    ),
  },
  // Two shaded boxes side by side, each address one /P with line breaks (the second box also
  // framed), a list item with a manual break and a justified paragraph with one.
  'address-boxes.pdf': {
    tagged: true,
    html: html(
      `
<h1>Party details</h1>
<p>This sheet lists the two parties to the hire agreement and how to reach them. Each address is one paragraph with line breaks, as a word processor writes it.</p>
<div class="parties">
<p class="party">Harbour Rowing Club<br>The Boathouse, Quay Road<br>Port Allery PA3 7RW<br>secretary@harbour-rowing.example</p>
<p class="party framed">Elena Marsh<br>14 Quayside Terrace<br>Port Allery PA2 4LN<br>elena.marsh@example.com<br>+44 20 7946 0958</p>
</div>
<ul>
<li>Bring the signed copy to the boathouse,<br>or post it to the Club Secretary before the end of the month.</li>
<li>Keep a copy for your records.</li>
</ul>
<p class="just">The deposit is returned within fourteen days after the event, less the cost of any cleaning or repair that the use of the room made necessary.<br>Any deduction is explained in writing. The Club keeps receipts for every repair and shows them to the Hirer on request, together with photographs of the damage taken on the day after the event.</p>`,
      '.parties { display: flex; gap: 14pt; margin: 4pt 0 12pt; } .party { flex: 1; margin: 0; padding: 12pt 14pt; background: #eef2f6; } .framed { border: 0.75pt solid #6b7a8c; } .just { text-align: justify; }',
    ),
  },
  // A table of short cells between two paragraphs.
  'table.pdf': {
    tagged: false,
    html: html(
      `
<p>The tide table below lists the expected high water at the three piers for the first week of the season. Times are given in local time.</p>
<table>
<tr><th>Day</th><th>North pier</th><th>Old quay</th><th>Ferry slip</th></tr>
<tr><td>Monday</td><td>06:12</td><td>06:20</td><td>06:31</td></tr>
<tr><td>Tuesday</td><td>06:58</td><td>07:05</td><td>07:17</td></tr>
<tr><td>Wednesday</td><td>07:41</td><td>07:49</td><td>08:02</td></tr>
<tr><td>Thursday</td><td>08:25</td><td>08:33</td><td>08:44</td></tr>
</table>
<p>Visitors should allow an extra half hour on days with an onshore wind, when the water often comes in earlier than the table says.</p>`,
      'table { border-collapse: collapse; margin: 6pt 0 12pt; } th, td { text-align: left; padding: 3pt 18pt 3pt 0; } th { font-weight: bold; }',
    ),
  },
};

async function chromePage(
  chrome: string,
  dir: string,
  file: string,
  source: string,
  tagged: boolean,
) {
  const input = join(dir, file.replace(/\.pdf$/, '.html'));
  const output = join(dir, file);
  writeFileSync(input, source);
  execFileSync(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${output}`,
      `file://${input}`,
    ],
    { stdio: 'ignore' },
  );
  const doc = await PDFDocument.load(readFileSync(output), { updateMetadata: false });
  if (!tagged) {
    doc.catalog.delete(PDFName.of('StructTreeRoot'));
    doc.catalog.delete(PDFName.of('MarkInfo'));
    for (const page of doc.getPages()) page.node.delete(PDFName.of('StructParents'));
  }
  if (doc.getPageCount() !== 1) throw new Error(`${file}: ${doc.getPageCount()} pages`);
  doc.setCreator(CREATOR);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  writeFileSync(join(OUT, file), await doc.save({ useObjectStreams: false }));
}

// --- The LaTeX-like page ---

/** Paragraph sources: `|` marks hyphenation points. */
const LATEX_PARAGRAPHS = [
  'The tidal gauge at the west|ern jetty was in|stalled in the spring and cal|i|brated against the old stone mark|ings on the har|bour wall. Its first months of data con|firmed what the fish|er|men had al|ways claimed: the flood tide ar|rives a few min|utes ear|lier at the jetty than at the ferry slip, and the dif|fer|ence grows with the strength of the west|erly wind. A sim|ple float and pul|ley records the level on a pa|per drum, which is changed ev|ery Mon|day.',
  'For the sec|ond sea|son the float was re|placed by a pres|sure sen|sor, and the pa|per drum by a small log|ger that stores one read|ing per minute. The new read|ings agree with the old ones to within a few mil|li|me|tres, but they re|veal short os|cil|la|tions that the float had smoothed away. These seiches, as they are called, ap|pear to be driven by the shape of the bay it|self rather than by the tide.',
];

async function latexPage(): Promise<void> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Tidal measurements');
  doc.setCreator(CREATOR);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const page = doc.addPage([595.28, 841.89]);
  const ctx = doc.context;
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const encoding = ctx.obj({
    Type: 'Encoding',
    BaseEncoding: 'WinAnsiEncoding',
    Differences: [1, PDFName.of('fi'), PDFName.of('fl')],
  });
  const roman = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: encoding }),
  );
  const bold = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Times-Bold',
      Encoding: 'WinAnsiEncoding',
    }),
  );
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: roman, F2: bold } }));

  const size = 10.5;
  const leading = 13;
  const left = 100;
  const indent = 15;
  // Advance widths (AFM units): single characters, ligatures fi = fl = 556.
  const charWidth = (ch: string) => times.widthOfTextAtSize(ch, 1000);
  const width = (word: string) => {
    let w = 0;
    for (let i = 0; i < word.length; i++) {
      const pair = word.slice(i, i + 2);
      if (pair === 'fi' || pair === 'fl') {
        w += 556;
        i++;
      } else w += charWidth(word[i] as string);
    }
    return (w * size) / 1000;
  };
  // Literal string: escapes, then the ligatures as octal codes 1 and 2 (`/Differences`).
  const encode = (word: string) =>
    word
      .replace(/[\\()]/g, (c) => `\\${c}`)
      .replace(/fi/g, '\\001')
      .replace(/fl/g, '\\002');
  const space = (250 * size) / 1000;

  // The widest measure (from 395 pt down) at which at least three line ends are hyphenated.
  const layout = (measure: number) => {
    const ops: string[] = [
      'BT',
      `/F2 12 Tf 1 0 0 1 ${left} 760 Tm (1  Tidal measurements) Tj`,
      'ET',
    ];
    let y = 734;
    let hyphenated = 0;
    for (const source of LATEX_PARAGRAPHS) {
      const words = source.split(' ');
      const lines: string[][] = [];
      let line: string[] = [];
      let lineWidth = indent;
      const plain = (w: string) => w.replace(/\|/g, '');
      let k = 0;
      while (k < words.length) {
        const word = words[k] as string;
        const add = (line.length > 0 ? space : 0) + width(plain(word));
        if (lineWidth + add <= measure) {
          line.push(plain(word));
          lineWidth += add;
          k++;
          continue;
        }
        // Hyphenate: the longest prefix at a `|` that fits with its hyphen.
        const parts = word.split('|');
        let split = 0;
        for (let p = parts.length - 1; p >= 1; p--) {
          const head = `${parts.slice(0, p).join('')}-`;
          if (lineWidth + (line.length > 0 ? space : 0) + width(head) <= measure) {
            split = p;
            break;
          }
        }
        if (split > 0) {
          line.push(`${parts.slice(0, split).join('')}-`);
          words[k] = parts.slice(split).join('|');
          hyphenated++;
        }
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      if (line.length > 0) lines.push(line);
      lines.forEach((ws, i) => {
        const last = i === lines.length - 1;
        const x = left + (i === 0 ? indent : 0);
        const natural = ws.reduce((n, w) => n + width(w), 0);
        const avail = measure - (i === 0 ? indent : 0);
        const gap = last || ws.length < 2 ? space : (avail - natural) / (ws.length - 1);
        const tj = ws
          .map((w, j) => `${j > 0 ? `${(-(gap * 1000) / size).toFixed(1)} ` : ''}(${encode(w)})`)
          .join(' ');
        ops.push(`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y.toFixed(2)} Tm [${tj}] TJ ET`);
        y -= leading;
      });
      y -= 4;
    }
    return { ops, hyphenated };
  };
  let result = layout(395);
  for (let m = 394; result.hyphenated < 3 && m >= 330; m--) result = layout(m);
  if (result.hyphenated < 3) throw new Error('latex-justified.pdf: too few hyphenated line ends');
  const { ops } = result;
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops.join('\n'))));
  writeFileSync(join(OUT, 'latex-justified.pdf'), await doc.save({ useObjectStreams: false }));
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  // File names on the command line build only those (Chromium output varies by version).
  const only = new Set(process.argv.slice(2));
  const wanted = (file: string) => only.size === 0 || only.has(file);
  const chrome = findChrome();
  const dir = mkdtempSync(join(tmpdir(), 'text-edit-corpus-'));
  for (const [file, page] of Object.entries(PAGES)) {
    if (!wanted(file)) continue;
    await chromePage(chrome, dir, file, page.html, page.tagged);
    console.log(`wrote ${file}`);
  }
  if (!wanted('latex-justified.pdf')) return;
  await latexPage();
  console.log('wrote latex-justified.pdf');
}

await main();

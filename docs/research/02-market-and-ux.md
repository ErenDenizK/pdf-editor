---
title: "Research: PDF editor landscape, user complaints, design references"
date: 2026-09-26
status: snapshot
---

> Research snapshot gathered on 2026-09-26. Star counts, prices and release states will drift. Product decisions derived from this document live in `docs/VISION.md`, `docs/ROADMAP.md` and `docs/DESIGN.md`.

# PDF Editor Landscape & UX Research (as of 2026-09-26)

**Method and caveats.** Facts below were gathered live via web search, direct fetches of GitHub repos/issues/releases, and secondary coverage. Two important access limits: `news.ycombinator.com` (and every HN mirror/API tried), `reddit.com`, Trustpilot, Capterra, and most vendor pricing pages were blocked by the egress proxy, so HN/Reddit sentiment is reported via search-engine summaries and secondary articles (XDA, PCWorld, GitHub issues), not verbatim threads. Where a source was only a search summary I say so. GitHub data (stars, issues, releases) was fetched directly and is reliable. Note also that the fetch tool repeatedly mis-rendered release years; I corrected these using repo creation dates and version cadence and flag them where relevant.

---

## 1. Landscape

### 1a. Online SaaS (all server-side unless noted)

| Tool | Free tier / limits | Processing | Notable complaints |
|---|---|---|---|
| **iLovePDF** | Free: per-tool file caps (~200 MB compress, ~100 MB split), ads, no batch/OCR; Premium €4/mo annual, €7/mo monthly ([search summary of pricing/reviews](https://tekpon.com/software/ilovepdf/pricing/), [getapp](https://www.getapp.com/collaboration-software/a/ilovepdf/)) | Server-side upload | Ads, batch and OCR paywalled, mobile-only/online-only for free users |
| **Smallpdf** | Free: **2 tasks/day across all tools**, ads, watermark on some outputs, files kept 1 h on servers; Pro ~$9–12/mo ([g2 pricing](https://www.g2.com/products/smallpdf/pricing), [exactpdf summary](https://exactpdf.com/blog/smallpdf-free-limits-2026)) | Server-side | Trustpilot themes (via search): charged after "free trial" despite cancelling (Nov 2025, Sept 2026 examples), unclear trial terms ([trustpilot summary](https://www.trustpilot.com/review/smallpdf.com)) |
| **PDF24 Tools** | Genuinely free, no caps; German company (Geek Software GmbH), EU servers, files deleted after 1 h ([pdf24 FAQ](https://tools.pdf24.org/en/faq), [review summary](https://mconverter.eu/blog/is-pdf24-safe/)) | **Online tools upload to server**; only the Windows-only desktop "PDF24 Creator" is local | Windows-only for offline use; web UI is a grid of ~40 single-purpose tools (no unified document workspace) |
| **Sejda** | Free: **3 tasks/hour**, 50 MB, 200 pages; Web $7.50/mo, Desktop+Web $63/yr ([summary](https://exactpdf.com/blog/sejda-pdf-editor-free-limits-2026), [makerstack](https://makerstack.co/reviews/sejda-review/)) | Server-side (desktop app is local) | Hourly wall hits mid-task; frequently cited as "the best free visual editor, with limits" |
| **Adobe Acrobat online** | Without sign-in: **one free transaction, one download**; sign-in gives free fill/sign/comment; 100 MB general cap (2 GB compress); **online editor cannot edit existing body text** — that needs Acrobat Pro trial/subscription; Standard $14.99/mo annual, $24.99 month-to-month ([Adobe FAQ](https://helpx.adobe.com/document-cloud/faq/try-acrobat-online-services.html), [pricing summary](https://xodo.com/blog/adobe-acrobat-pricing-explained)) | Server-side (Document Cloud) | Forced sign-in nags even in Reader ([Adobe community](https://community.adobe.com/questions-12/acrobat-reader-asking-to-sign-in-1506942)); "editing in Adobe is the worst": can't edit individual boxes, auto-selects whole regions, undo wipes everything ([Adobe community](https://community.adobe.com/t5/acrobat-reader-mobile-discussions/editing-in-adobe-is-the-worst/m-p/15476322)); "$200/yr to edit a simple PDF still feels unreasonable in 2025" ([dev.to](https://dev.to/larop6547/how-to-edit-pdf-offline-without-adobe-free-tools-that-work-in-2025-2i9d)) |
| **Xodo** (Apryse) | Was free for years; now **1 free action/day**; Web $7.99/mo annual, Desktop $9.99/mo, Suite $14.99/mo, $240 perpetual ([xodo plans](https://xodo.com/blog/xodo-plans-explained), [makerstack](https://makerstack.co/reviews/xodo-review/)) | Server-side web; desktop local | Users angry about post-acquisition paywall; editing quality itself praised |
| **PDFgear** | Fully free, no watermark, proprietary (desktop Win/Mac/iOS/Android + web) ([TechRadar](https://www.techradar.com/pro/software-services/pdfgear-review)) | Desktop mostly local; **some features (compression, AI) upload to servers** ([pdfgear insights](https://www.pdfgear.com/insights/is-pdfgear-free.htm)) | PCMag: "by far the best free PDF editor" but "not nearly as easy to use as paid apps… difficult or impossible to perform some editing tasks"; recurring "what's the catch / where does my data go" skepticism, enough that PDFgear published a [Reddit disinformation statement](https://www.pdfgear.com/reddit-disinformation-statement/) |
| **Soda PDF** | Free: **2 files/day or ≤3 MB**, editing/OCR/forms excluded; Standard ~$7/mo annual ([Capterra pricing](https://www.capterra.com/p/226942/SODA-PDF/pricing/), [Soda free-access policy](https://www.sodapdf.com/blog/soda-pdf-free-access-policy/)) | Server-side | Trustpilot/PissedConsumer themes: surprise renewals at higher price, hidden extra fees, hard to cancel, "PRO still couldn't edit my PDF" ([summary](https://www.trustpilot.com/review/www.sodapdf.com)) |
| **pdfFiller** | No real free tier: edit, then **paywall at download**; ~$144/yr charged after "cancelled" trials ([Trustpilot summary](https://www.trustpilot.com/review/pdffiller.com), [PissedConsumer 2.0/5](https://pdffiller.pissedconsumer.com/review.html)) | Server-side | The canonical "do the work, then pay to download" dark pattern |
| **Canva PDF editor** | Free with Canva account | Server-side; **converts the PDF into a Canva design** | Fonts substituted, layouts break, scanned PDFs become one flat image, multi-page/complex PDFs degrade ([Canva help](https://www.canva.com/help/import-and-edit-pdfs-canva/), [review](https://lightpdf.com/canva-pdf-editor-review.html)) |

**Pattern:** every mainstream SaaS uses one of three monetisation walls — task quota (Smallpdf 2/day, Sejda 3/h, Xodo 1/day, Soda 2/day), size cap, or post-edit paywall (pdfFiller, Adobe "edit text") — and all require uploading files. PDF24 is the only "free with no limits" SaaS, and it still uploads.

### 1b. Open-source / self-hosted

**Stirling-PDF** — Java/Spring backend + React 19/TS/Vite (Mantine + Tailwind) frontend since v2; server-side processing; 93.1k stars; Docker/K8s/desktop ([repo](https://github.com/Stirling-Tools/Stirling-PDF)).
- **Licensing pivot:** v0.46.2 was pure MIT. v1.0.0 introduced a dual license; today the LICENSE file lists ten proprietary directories (`app/proprietary/`, `app/saas/`, `engine/`, `frontend/editor/src/{proprietary,desktop,saas,cloud,prototypes,portal,portal-saas}`) under a non-FOSS "Stirling PDF User License" ([LICENSE](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/LICENSE), [isitreallyfoss](https://isitreallyfoss.com/projects/stirling-pdf/)). Community backlash centred on SSO being paywalled ("calling it 'advanced authentication' and putting SSO behind a paywall is pretty pathetic") ([discussion #4332](https://github.com/Stirling-Tools/Stirling-PDF/discussions/4332)).
- **Pricing:** Free ≤5 users; Team $99/mo or $999/yr per server (100-user blocks); Enterprise custom (~$12/seat) with SAML, audit logs, air-gap ([Paid-Offerings.md](https://github.com/Stirling-Tools/Stirling-Tools.github.io/blob/main/docs/Paid-Offerings.md), [stirling.com/pricing](https://www.stirling.com/pricing)).
- **v2.0 (Nov 2025):** full React rewrite, files persist across tools, undo/redo/version history, desktop apps; **text editing shipped alpha for paying users only** ([v2.0.0 notes](https://github.com/Stirling-Tools/Stirling-PDF/releases/tag/v2.0.0), [heise](https://www.heise.de/en/news/Stirling-PDF-2-0-Major-update-of-the-open-source-alternative-to-Adobe-Acrobat-11095732.html)). Some users asked for a toggle back to the old UI ([#5086](https://github.com/Stirling-Tools/Stirling-PDF/issues/5086)); a third-party "StirlingX — reimagined UI… faster, cleaner" fork appeared (StirlingX, `github.com/SubhamPro11/StirlingX`; the repository was gone by 2026-10-01).
- **v3.0.0 (24 Sept 2026, two days ago):** new text editor out of alpha, "PDF Processor" batch automation (folders/FTP/S3), **OAuth SSO free for all** (reversing the v1 paywall), reader view, quick-access bar; but **automation/API/AI now metered: 1,000 PDFs/month free, +500 if you link the self-hosted instance to stirling.com** ([v3.0.0](https://github.com/Stirling-Tools/Stirling-PDF/releases/tag/v3.0.0), [releases](https://github.com/Stirling-Tools/Stirling-PDF/releases)). Usage metering on a self-hosted "open-source" app is a new friction point worth watching.
- **Privacy/telemetry:** PostHog (EU) + Scarf tracking pixel (`pixel.stirling.com`); a 2025 issue alleged the pixel "sends data even when users opt out" ([#3283](https://github.com/Stirling-Tools/Stirling-PDF/issues/3283)); docs now say analytics are opt-in via consent banner and admin-disableable ([docs](https://docs.stirlingpdf.com/analytics-telemetry/)). Self-hosters also objected to an "Upgrade to Pro" banner ("a bit too in-your-face for a community open-source project", [#2974](https://github.com/Stirling-Tools/Stirling-PDF/issues/2974)) and a nag to become default PDF app on every launch ([#5772](https://github.com/Stirling-Tools/Stirling-PDF/issues/5772)).
- **UX complaints in issues:** desktop app "always opens in the browser… doesn't feel like a truly local application" (closed not-planned, [#3679](https://github.com/Stirling-Tools/Stirling-PDF/issues/3679)); no tabs for multiple PDFs ([#4750](https://github.com/Stirling-Tools/Stirling-PDF/issues/4750)); hover layout shifts that "make a great piece of software look buggy" ([#3957](https://github.com/Stirling-Tools/Stirling-PDF/issues/3957)); oversized panels, non-collapsing sections ([#6742](https://github.com/Stirling-Tools/Stirling-PDF/issues/6742)); users wanted a proper reader with fluid scroll, lazy loading, keyboard first/last page ([#3818](https://github.com/Stirling-Tools/Stirling-PDF/issues/3818)). Top-reacted historical requests: fillable forms ([#320](https://github.com/Stirling-Tools/Stirling-PDF/issues/320), still open/in-progress since 2023), edit text directly ([#1141](https://github.com/Stirling-Tools/Stirling-PDF/issues/1141)), disable Pro upsell, Flatpak, remember reading position.

**BentoPDF** — Vite/TS/Tailwind, fully client-side (pdf.js, pdf-lib, qpdf-wasm, wasm-vips, LibreOffice WASM, plus CDN-loaded PyMuPDF/Ghostscript/CoherentPDF WASM); AGPL-3.0 with $79 one-time commercial license; 15.7k stars, created Oct 2025; 50+ tools; Docker/static/air-gapped bundles ([repo](https://github.com/alam00000/bentopdf)).
- v2.8.8 (Aug 2026) added **in-browser text editing with live reflow and automatic font matching**, but "Local fonts access is only available on chromium based browsers" ([v2.8.8](https://github.com/alam00000/bentopdf/releases/tag/v2.8.8)).
- Praised by XDA as an "upgrade" over Stirling for privacy and a "super-clean, modern, professional dark-mode design that looks like a high-end paid app" ([XDA](https://www.xda-developers.com/bentopdf-over-stirlingpdf-as-primary-pdf-toolkit/)).
- Weak spots: editor depended on an external EmbedPDF.js URL, breaking on locked-down networks ([#227](https://github.com/alam00000/bentopdf/issues/227)); WASM out-of-bounds memory on compression ([#346](https://github.com/alam00000/bentopdf/issues/346)); FAQ block covering the work area at 100–120 % zoom ([#864](https://github.com/alam00000/bentopdf/issues/864)); "Used by companies…" marketing banner even in the `simple` self-host image ([#329](https://github.com/alam00000/bentopdf/issues/329)); Docker Hub namespace lost in a migration mishap (Jan 2026 security notice, [#399](https://github.com/alam00000/bentopdf/issues/399)); still-open requests for a desktop app ([#153](https://github.com/alam00000/bentopdf/issues/153)) and editing existing text ([#144](https://github.com/alam00000/bentopdf/issues/144), now partly addressed). Architecturally it is a "many separate tools" toolkit, not a single document workspace.

**PDF Arranger** — Python/GTK3 + pikepdf + poppler; GPL-3.0; 5.9k stars; Linux/Win/mac/FreeBSD; latest 1.14.0 (zoom, outline rebuild on merge, swap odd/even) ([repo](https://github.com/pdfarranger/pdfarranger), [releases](https://github.com/pdfarranger/pdfarranger/releases)). Does one thing — a thumbnail grid you drag — and is repeatedly named the reference for reordering: "The drag-and-drop interface is so intuitive. I can rearrange a 50-page document in seconds"; "shows every page as a thumbnail you move with your mouse, instead of a form where you type page numbers and hope you got them right" ([search summary](https://itsfoss.com/pdfarranger-app/), [pdfarranger.net](https://pdfarranger.net/)).

**pdfcpu** — Go, Apache-2.0, 8.9k stars; CLI/API for validate/optimize/merge/split/rotate/encrypt/sign/extract; PDF 2.0; v0.16.0-rc.1 (Sept 2026, Go 1.26) ([repo](https://github.com/pdfcpu/pdfcpu), [releases](https://github.com/pdfcpu/pdfcpu/releases)). Compiles to WASM ([go-wasm-pdfcpu](https://github.com/wcchoi/go-wasm-pdfcpu)); PDFSlice uses `@hyzyla/pdfcpu` in-browser. No UI; a viable engine candidate for page-level ops.

**PDFsam Basic** — Java/JavaFX, AGPL-3.0, 4.6k stars; split/merge/mix/rotate/extract only; JDK 25 ([repo](https://github.com/torakiki/pdfsam)). Reviews: "interface old-fashioned", no live preview when merging/reordering, upgrade prompts to the paid Enhanced edition ([Capterra summary](https://www.capterra.com/p/182728/PDFsam-Basic/reviews/)).

**Firefox / pdf.js** — Apache-2.0; latest release v6.3.289 (Aug 2026 by cadence) with continuous "annotation editing", comment sidebar, digital-signature verification (v6.2.108) work ([releases](https://github.com/mozilla/pdf.js/releases)). Editor today: add text (color/size), draw ink (color/thickness/opacity), highlight, insert image, signatures (type/draw/image, explicitly *not* legally binding), forms, comments ([firefox.com PDF editor](https://www.firefox.com/en-US/features/pdf-editor/)). **Firefox 150 (21 Apr 2026) added page management: "reorder, copy, paste, delete, and export pages"** ([release-notes JSON](https://github.com/mozilla/release-notes/blob/master/releases/firefox-150.0-release.json), [PCWorld](https://www.pcworld.com/article/3121683/firefox-150-turns-its-pdf-viewer-into-a-real-pdf-editor.html)); Firefox 156 opens PDFs 45 % faster. Still no true text editing, no merge of separate files, no shapes (open request [#15588](https://github.com/mozilla/pdf.js/issues/15588)). This is now the strongest *zero-install, fully local* baseline — your app must beat it clearly.

**Chrome PDF viewer** — Chrome 145 (Feb 2026) added native annotations: highlight, draw, notes, signature, eraser, size/colour panel; download "with or without" annotations; Save to Google Drive ([MacRumors](https://www.macrumors.com/2026/02/19/chrome-split-view-pdf-annotations/), [Google help](https://support.google.com/chrome/answer/16215622)). No page management, no text editing.

**LibreOffice Draw** — MPL-2.0; imports PDF as vector graphics, "every line of text into an independent text box"; edits reflow badly, boxes fragment "line by line or even word by word", missing fonts shift layout ([Ask LibreOffice](https://ask.libreoffice.org/t/why-and-when-did-libre-draw-break-my-layout/90117), [UPDF guide](https://updf.com/edit-pdf/edit-pdf-with-libreoffice/)). Cautionary example of "text editing" that technically exists but users hate.

**Okular** — GPL, KDE; rich annotation toolbar (highlight, underline, squiggle, free text, inline/popup notes, stamps), form filling; complaints: annotations not visible in other readers ([KDE bug 353400](https://bugs.kde.org/show_bug.cgi?id=353400)), no text/image editing, DRM obeyed by default, freehand drawing weak.

**Xournal++** — C++/GTK3, GPL-2.0, 15.4k stars; excellent pen/handwriting; but native `.xopp` links (not embeds) the PDF and annotations are editable only in `.xopp`, exported PDFs are flattened ([repo](https://github.com/xournalpp/xournalpp)).

**pdfux** — closed-source privacy-first web tools (merge/split/edit locally); no repo found ([pdfux.com](https://pdfux.com/)). **PDFMate** — old freeware Windows merger (Anvsoft), irrelevant except as evidence of the "simple merger" niche. **Emacs pdf-tools** — Emacs viewer/annotator; irrelevant to this audience.

### 1c. New 2025–2026 client-side / WASM web apps

| Project | Stack / engine | License | Stars | Notes |
|---|---|---|---|---|
| **EmbedPDF** ([repo](https://github.com/embedpdf/embed-pdf-viewer)) | PDFium WASM (own "EmbedPDF Runtime" fork), plugin architecture, React/Vue/Svelte/vanilla | Apache-2.0 (CloudPDF server FCL) | 4.5k | Highlight/sticky/free-text/ink annotations, **true redaction**, search, virtual scroll; v3 (pre-release) adds digital signatures, rich-text FreeText, measurement, version history ([releases](https://github.com/embedpdf/embed-pdf-viewer/releases)). HN "Show HN: I built a free alternative to Adobe Acrobat PDF viewer" (Aug 2025): "Acrobat is heavy, closed, and pricey… lightweight, hackable, embeddable" ([HN](https://news.ycombinator.com/item?id=44901683), [HN June 2025](https://news.ycombinator.com/item?id=44126177)). PDF Association member since Jan 2026. **Strongest engine candidate** for a client-side editor. |
| **Folio** ([repo](https://github.com/ziloris-project/Folio)) | Next.js 16/React 19, PDFium WASM, pdf-lib, Zustand, Radix | MIT | 4 | Alpha; claims true text editing with paragraph re-wrap, font upload, page management incl. merge, annotations, undo/redo snapshots. Tiny community but the closest existing spec to your thesis. |
| **OpenPdfEdit** ([repo](https://github.com/open-pdf-edit/openpdfedit)) | Rust core → WASM, Svelte, Tauri desktop, Tesseract.js | AGPL-3.0 (was MIT/Apache ≤1.0.1) | 24 | Annotate, edit text, forms, redact, merge/split/compare/OCR; OCR & watermark need a paid "Supporter" credit account — another paywall-inside-OSS pattern to avoid. |
| **LocalPDF** family | pdf-lib + pdfjs v6, service-worker PWA, strict CSP blocking outbound requests (in-app "Private" badge) | MIT ([nicanor-korir/localPDF](https://github.com/nicanor-korir/localPDF)) | small | Several unrelated "LocalPDF" sites/repos exist (localpdf.online, local-pdf.com, localpdfs.com, LocalPDF Studio); HN Oct 2025 & Mar 2026 posts; author noted ChatGPT is the largest traffic source ([HN 45508184](https://news.ycombinator.com/item?id=45508184), [HN 47313392](https://news.ycombinator.com/item?id=47313392)). The **verifiable-privacy CSP badge** is a UX idea worth stealing. |
| **PDFSlice** ([repo](https://github.com/ShashwatSricodes/PDFSlice)) | React/TS, pdf-lib, pdf.js, pdfcpu WASM | MIT | 205 | Merge/split/reorder/rotate/compress/protect/redact/forms; 11 commits, stalled. |
| **Orbit** ([repo](https://github.com/kanakkholwal/orbit)) | Svelte 5, pdf-lib, qpdf-wasm, Tauri | GPL-3.0 | 101 | Merge/split/compress + multi-tool with drag-sort; dark/light. |
| **local-pdf-tools** ([repo](https://github.com/krmanik/local-pdf-tools)) | Ghostscript WASM in a Web Worker | AGPL-3.0 | 61 | Proof that Ghostscript-grade compression works client-side without blocking the UI. |
| **BreezePDF** / **TechRex PDF editor** | in-browser editors posted to HN (Mar 2026 / Jan 2026) ([HN 47563103](https://news.ycombinator.com/item?id=47563103), [HN 46754607](https://news.ycombinator.com/item?id=46754607)); the May 2025 "Show HN: Free, in-browser PDF editor" was built "because many PDF tools found on Google upload documents to a server" ([HN 43880962](https://news.ycombinator.com/item?id=43880962)) | unknown | — | Comments not retrievable (HN blocked). |
| **KillerPDF** ([repo](https://github.com/SteveTheKiller/KillerPDF)) | C#/WPF, PDFium, own PDF 2.0 engine; **Windows-only desktop** | GPL-3.0 | 4.0k in 5 months | Not web, but shows demand: 13 themes, F1 shortcut overlay, "No account or telemetry", tested on 2,900-file corpus. Text "editing" is actually annotation text boxes with font matching. |
| **Open PDF Studio** ([repo](https://github.com/OpenAEC-Foundation/open-pdf-studio)) | Tauri 2 + Rust, SolidJS, PDFium worker pool | LGPL-3.0 | 838 | Desktop; AEC markup/measure; Office-style ribbon — the opposite design direction. |
| **ShizukuIchi/pdf-editor** ([repo](https://github.com/ShizukuIchi/pdf-editor)) | vanilla JS, offline | MIT | 1.9k | Add text/images/signatures; last commit Feb 2024 — abandoned but still linked everywhere, evidence of unmet demand for a simple offline editor. |
| Others seen | `signaturepdf` (PHP server-side signing + page organise, AGPL, 831★), `leed_pdf_viewer` (Svelte pen-annotation, AGPL, 437★), `SimplePDF/simplepdf-embed` (MIT embed, commercial backend, 408★), `Karna14314/Pdf_Tools` (Android offline, 603★), `clawpdf` (zero-dep PDFium WASM bindings, 104★), `@hyzyla/pdfium`, `@embedpdf/pdfium` npm | | | |

**Engine licensing note for a client-side app:** PDFium WASM is Apache-2.0/BSD (EmbedPDF, clawpdf, @hyzyla/pdfium); MuPDF WASM is AGPL-3.0 with commercial licence from Artifex and is generally rated higher fidelity ([mupdf.js](https://github.com/ArtifexSoftware/mupdf.js/), [comparison](https://www.syncfusion.com/blogs/post/pdf-rendering-engines-comparison)); pdf.js is Apache-2.0 and best for rendering/text-layer, weak for writing; pdf-lib (MIT) writes but cannot re-subset fonts; qpdf-wasm/pdfcpu-wasm/Ghostscript-wasm (AGPL) cover structural ops and compression.

---

## 2. Top recurring user complaints (synthesised, with sources)

1. **Upload-to-cloud privacy.** The dominant motivation behind every 2025–26 launch: BentoPDF, LocalPDF ("built to address privacy concerns of uploading personal documents"), the May-2025 HN editor, ZeroUploadPDF etc. XDA readers "ditched Stirling" partly over the tracking-pixel discovery ([XDA](https://www.xda-developers.com/replaced-stirling-pdf-with-this-self-hosted-pdf-toolkit/), [#3283](https://github.com/Stirling-Tools/Stirling-PDF/issues/3283)). Even self-hosted OSS is now distrusted if it phones home.
2. **Paywall after doing the work.** pdfFiller (edit → pay to download), Adobe online (annotate free, edit text = Pro), Soda ("PRO still couldn't edit"), Stirling v2 (text editing alpha for payers only) ([Trustpilot pdfFiller](https://www.trustpilot.com/review/pdffiller.com), [Adobe FAQ](https://helpx.adobe.com/document-cloud/faq/try-acrobat-online-services.html)).
3. **Quotas & size limits.** Smallpdf 2/day, Sejda 3/h, Xodo 1/day, Soda 2 files or 3 MB, "File too large" errors cited by LocalPDF's author ([HN 47313392](https://news.ycombinator.com/item?id=47313392)).
4. **Billing traps.** Charged after cancelling trials (Smallpdf, pdfFiller, Soda), silent renewals at higher prices, email-only cancellation.
5. **Watermarks & ads** on free tiers (Smallpdf, iLovePDF ads, PDF-XChange OCR watermark).
6. **No true text editing / breaks fonts & layout.** Canva substitutes fonts and flattens scans; LibreOffice Draw fragments text boxes; Adobe "can't edit individual boxes"; PCMag on PDFgear "difficult or impossible to perform some editing tasks". Root cause is technical: PDFs embed *subset* fonts (missing glyphs you never typed), so any replacement font reflows/overlaps ([prepressure](https://www.prepressure.com/pdf/basics/fonts), [dev.to explainer](https://dev.to/vbhattaccmu/why-editing-one-word-in-a-pdf-is-so-much-harder-than-it-looks-9jh)). BentoPDF's new editor only gets local fonts on Chromium.
7. **Bloated / cluttered / slow UI.** Stirling: "slow since it's a webpage rendered with Tauri", "clunky and cluttered for simple viewing", hover layout shifts, oversized panels, nag banners, Pro upsell; PDFsam "old-fashioned"; Okular "overwhelming"; Acrobat "heavy". Users literally built a fork (StirlingX) for a "faster, cleaner" UI.
8. **Merge/reorder pain.** Praise for PDF Arranger is phrased as relief from "typing page numbers and hoping"; PDFsam users want a live preview when merging/reordering; BentoPDF users asked for reverse-order bulk upload ([#54](https://github.com/alam00000/bentopdf/issues/54)) and organise-by-page-number ([#361](https://github.com/alam00000/bentopdf/issues/361)); Firefox only got page reorder in 2026.
9. **Tool-grid architecture instead of a document workspace.** PDF24/iLovePDF/BentoPDF/Stirling-v1 make you pick a tool, upload, download, then repeat for the next tool. Stirling v2's headline fix was exactly "upload once, perform multiple actions… undo/redo/version history" ([heise](https://www.heise.de/en/news/Stirling-PDF-2-0-Major-update-of-the-open-source-alternative-to-Adobe-Acrobat-11095732.html)); Stirling users want tabs for multiple PDFs.
10. **Missing reader basics** even in "editors": fluid scroll, lazy load for large files, keyboard first/last, remember last position, page-number jump ([#3818](https://github.com/Stirling-Tools/Stirling-PDF/issues/3818), [#5520](https://github.com/Stirling-Tools/Stirling-PDF/issues)).
11. **Forms.** Fillable-form creation is Stirling's oldest still-open top request (#320, 2023); BentoPDF #78; Folio lists AcroForm editing as unshipped.
12. **Memory / large files in the browser.** BentoPDF WASM OOM ([#346](https://github.com/alam00000/bentopdf/issues/346)); its FAQ concedes the limit is "your own computer". Any client-side app must stream, worker-offload, and degrade gracefully.
13. **Locked-down networks.** CDN-loaded WASM/engine breaks on corporate networks ([#227](https://github.com/alam00000/bentopdf/issues/227)); Stirling Enterprise sells "air-gapped" as a feature. Ship everything self-contained.
14. **Undo semantics.** Adobe "back button undoes everything instead of just the last action"; Stirling v2 shipped undo/redo as a headline feature — users expect editor-grade history.
15. **Annotation portability.** Okular/Xournal++ annotations not visible elsewhere or stuck in proprietary sidecars; Firefox signatures "not legally binding". Users expect standard PDF annotations that survive other viewers.

---

## 3. What users praise (the bar to beat)

- **Stirling's breadth**: "50+ tools", pipelines, API, self-host — "Swiss Army knife" ([noted.lol](https://noted.lol/stirling-pdf/)); 93k stars is the largest PDF community on GitHub.
- **BentoPDF's privacy + polish**: "everything runs entirely on the client-side… no hidden logs"; "super-clean, modern, professional dark-mode design that looks like a high-end paid app" ([XDA](https://www.xda-developers.com/bentopdf-over-stirlingpdf-as-primary-pdf-toolkit/)).
- **PDF24 being free with no caps** and EU/GDPR posture ([PDF24 FAQ](https://tools.pdf24.org/en/faq)).
- **Firefox's zero-install simplicity**: fill, sign, annotate, and since 150 reorder pages "without leaving the browser" ([firefox.com](https://www.firefox.com/en-US/features/pdf-editor/)).
- **PDF Arranger's thumbnail grid**: "rearrange a 50-page document in seconds", "opens in seconds", "a must have when I install on any new machine".
- **Apple Preview**: "when it comes to stripped-down design, Apple has no competition"; drag thumbnails between two windows' sidebars to merge; Contact Sheet view ([Apple support](https://support.apple.com/guide/preview/combine-pdfs-prvw43696/mac), [Macworld](https://www.macworld.com/article/2344562/apple-preview-review-2.html)).
- **PDFgear**: "fast, easy to use, and has all the features you actually need without locking everything behind a paywall" ([Trustpilot summary](https://ie.trustpilot.com/review/pdfgear.com)).
- **Xodo's editing depth** (even while people hate its new pricing).
- **KillerPDF**: shortcut overlay, themes, no telemetry, standards-tested — 4k stars in five months for a Windows-only app shows appetite for a *serious*, opinionated, free editor.
- **EmbedPDF**: "lightweight, hackable, embeddable", true redaction, virtualised scrolling.
- **LocalPDF's CSP "Private" badge**: making the privacy claim *verifiable in-app* was called out positively.

---

## 4. Feature prioritisation for a client-side editor

Ranking criteria: frequency in complaints/requests above, whether incumbents do it badly, feasibility with permissive-licence WASM engines.

### v1 (MVP) — "the document workspace that never uploads"
1. **Merge multiple PDFs with drag-drop reorder (mandatory).** Multi-file drop zone → one continuous **page grid ("light table")** where pages from different sources are colour-tagged, draggable individually or as file blocks, with marquee multi-select, rotate/delete per page, reverse order, interleave (odd/even / duplex sort — requested in BentoPDF & PDFsam), and live preview. Output rebuilds outlines/bookmarks (PDF Arranger 1.14 feature). Beats: PDFsam (no preview), iLovePDF/Smallpdf (upload + quota), Firefox (no multi-file merge).
2. **Split / extract / delete / rotate / reorder pages** in the same grid (single mental model, no tool switching).
3. **Real viewer**: virtualised, lazy rendering; smooth zoom; thumbnails sidebar; page-number jump; find-in-text; keyboard nav (Home/End/PgUp/PgDn, ⌘/Ctrl+F, ⌘/Ctrl+G); remembers last position (localStorage). Stirling users are still asking for this.
4. **Multi-document tabs** (Stirling #4750).
5. **Undo/redo history** across all operations, with a visible history panel (Stirling v2 headline, Adobe complaint).
6. **Annotations that are standard PDF annotations**: highlight/underline/strikeout, free text, ink, shapes (line/rect/arrow — pdf.js still lacks this), sticky notes, image stamp, signature (draw/type/image) — saved as real annots so they survive in Acrobat/Chrome/Preview.
7. **Form filling** of existing AcroForms (flatten optional).
8. **Compress** (qpdf/Ghostscript-wasm in a Worker with presets), **password add/remove**, **metadata view/edit/strip**.
9. **Images → PDF**, **PDF → images** (PNG/JPEG per page).
10. **Privacy that is provable**: no network calls after load, strict CSP, in-app "Local-only" indicator (à la LocalPDF), offline PWA, no CDN-loaded engines (BentoPDF #227), no telemetry, no banners/upsells (Stirling #2974, BentoPDF #329).
11. **Keyboard-first + command palette (⌘K)** from day one; shortcut cheat-sheet overlay (KillerPDF F1).
12. **Large-file robustness**: Worker-based engines, streaming/incremental save, memory guard with graceful error (BentoPDF #346).

### v2 — "editing, not just organising"
1. **True text editing with honest constraints**: edit runs where the embedded subset has the glyphs; when it doesn't, offer (a) font upload, (b) matched substitute with visible "reflow risk" indicator, (c) whiteout+overlay fallback. Use Local Font Access where available (Chromium) and bundled open fonts elsewhere (BentoPDF's Chromium-only gap). Paragraph re-wrap within the block (Folio's approach), never LibreOffice-style per-line fragmentation.
2. **Image editing**: move/resize/replace/extract images; crop pages; resize/scale page (BentoPDF #846).
3. **True redaction** (content removal, not black boxes) — EmbedPDF has this; validate that redacted text is not searchable (their Sept 2026 fix shows how easy it is to get wrong).
4. **Form field creation** (text/checkbox/radio/dropdown) — Stirling's oldest open request.
5. **Bookmarks/outline editor**, page labels, **header/footer/page numbers**, **watermark**, **Bates stamping**.
6. **Compare two PDFs** (visual + text diff).
7. **OCR** via Tesseract-wasm in a Worker, producing searchable text layer; **PDF/A conversion** (Ghostscript-wasm or Kura-style engine).
8. **Batch/"apply to all files"** and saveable pipelines (Stirling Pipelines, BentoPDF Workflow) — without metering.
9. **Digital signature verification** (pdf.js v6.2, EmbedPDF v3 both shipped it) and, later, signing with local certificates.

### v3 — "ecosystem"
1. Office ↔ PDF conversion via LibreOffice WASM (large download; lazy-load only on demand).
2. Optional **desktop wrapper** (Tauri) for file associations and no-browser feel — the #1 Stirling desktop complaint is precisely "it opens in the browser".
3. Browser extension / "open with" for PDFs from the web.
4. Optional local-AI features (summarise, chat) strictly with user-supplied local models/keys — never a hosted meter.
5. Plugin API on top of the engine (EmbedPDF-style plugin architecture) so the community can add tools without bloating core.
6. Collaboration via export/import of annotation sets (Web Annotation JSON — pdf.js #15055), not a cloud.

**Explicit non-goals:** accounts, quotas, upsell banners, telemetry, CDN-loaded engines, "Pro" directories in the repo.

---

## 5. Design references and patterns

### Best-in-class dark/minimal products to study
- **Linear** — dark by default (#010102 canvas), a *surface ladder* (#0f1011 → #191a1b) with 1px hairline borders instead of shadows, one lavender accent (#5e6ad2) used only for brand/CTA/focus, negative-tracked display type, "the dark canvas IS the whitespace", ⌘K command menu, contextual panes that preserve place ([design tokens](https://github.com/voltagent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md), [Linear redesign post](https://linear.app/now/how-we-redesigned-the-linear-ui), [breakdown](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026)).
- **Raycast** — four-step grey ladder (#07080a → #121212), *no drop shadows anywhere*, hairline #242728 borders, Inter with `ss03`, positive letter-spacing for "airiness" on dark, saturated colour only inside icons never on chrome, keycap-style shortcut hints ([tokens](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/raycast/DESIGN.md)).
- **Vercel Geist** — neutrals only, accent "like punctuation", 200-step grey scale where every divider has its own step; Geist Sans/Mono open-source and now the de-facto dev-tool typeface ([Geist](https://vercel.com/geist/introduction)).
- **Arc** — chrome pushed into a collapsible sidebar; content-first.
- **Figma / Notion dark** — floating contextual property panels; Notion's ⌘K + slash commands.
- **Apple Preview** — "as bare and streamlined as can be": thumbnail sidebar you drag pages into, Contact Sheet grid, markup toolbar appears only when invoked.
- **tldraw** — canonical canvas-app layout: bottom-centre tool bar, top-right style panel that shows controls *for the current selection*, top-left menu, bottom-left zoom/nav, floating toolbars on text edit/image selection, touch-adapted menus ([tldraw UI docs](https://tldraw.dev/docs/user-interface), [components](https://tldraw.dev/sdk-features/ui-components)).
- **Excalidraw** — "Island" container primitive for every floating panel; its own history shows the anti-pattern of implementing dark mode via CSS `invert()` (27 fps vs 56, wrong colours) — theme the UI with tokens and leave the document canvas untouched ([issue #4616](https://github.com/excalidraw/excalidraw/issues/4616)).
- **Photopea** (from general knowledge, not verified this session) — proof a dense, desktop-grade dark editor works in a browser tab; borrow its "desktop app in a tab" seriousness, not its Photoshop-clone density.

### Concrete patterns to borrow for a document editor
1. **Page grid "light table"** (PDF Arranger / Preview Contact Sheet): thumbnails at adjustable size, source-file colour tags, marquee & ⇧-click selection, drag with insertion indicator, drop files anywhere onto the grid, per-page hover actions (rotate/delete/extract), and a mini-map/outline of the document order.
2. **Command palette (⌘K)** as the single entry point for *every* action ("must be the one place users can find every command" — [uxpatterns.dev](https://uxpatterns.dev/patterns/advanced/command-palette)); fuzzy search, recents, shows shortcuts, accepts arguments ("rotate 3-5 90").
3. **Floating contextual toolbar on selection** (tldraw/Figma/Notion): select text → highlight/underline/comment; select page(s) → rotate/delete/extract/move-to; select annotation → colour/stroke/opacity. Nothing shown that doesn't apply.
4. **Collapsible side panels**: left = thumbnails / outline / files; right = properties of selection / history / document info. Remember collapsed state (Stirling #6742 asked for exactly this).
5. **Keyboard-first**: every command has a shortcut; `?` shows an overlay; Esc always deselects tool (pdf.js request [#20199](https://github.com/mozilla/pdf.js/issues/20199)); arrow keys move selected pages in the grid.
6. **Non-destructive history panel** with named steps and branch-free undo/redo.
7. **Status/"privacy" indicator** in the chrome: "Local-only · 0 network requests" with a click-through explanation (LocalPDF).
8. **Progressive engine loading**: core viewer instantly; heavy WASM (OCR, LibreOffice, Ghostscript) fetched only when that tool is first invoked, with an explicit size shown.
9. **Surface hierarchy via tonal steps + hairline borders**, not shadows or blur, on the *working* surfaces; reserve translucency for chrome that floats over the document.

### Glass/translucency — do it carefully
NN/g, Axess Lab and 2026 critiques agree: blur + transparency inherently cut contrast, and WCAG 4.5:1 cannot be guaranteed over an unpredictable backdrop (a PDF page). Rules: use frosted glass **only for floating chrome over the document (toolbars, palettes), never for panels people read**; give every glass surface a **solid fallback** and a 1px border; increase tint opacity until text passes AA against both white pages and dark canvas; honour `prefers-reduced-transparency` / `prefers-contrast` ([NN/g](https://www.nngroup.com/articles/glassmorphism/), [Axess Lab](https://axesslab.com/glassmorphism-meets-accessibility-can-frosted-glass-be-inclusive/), [Codexical 2026](https://www.codexical.com/posts/2026-04-24-glassmorphism-accessibility)).

### Anti-patterns to avoid (all observed in the field)
- Tool-grid homepages (PDF24/iLovePDF/BentoPDF) that force upload→download→re-upload between operations.
- Office ribbons and 40-icon toolbars (Open PDF Studio, Acrobat) for a minimalist product.
- Upsell banners, "make me default" nags, cookie/consent banners in a local app (Stirling, BentoPDF simple image).
- Hover-induced layout shifts (Stirling #3957) — reserve space for hover states.
- Oversized help/FAQ blocks covering the work area (BentoPDF #864); anything that grows with zoom.
- CSS `filter: invert()` dark mode (Excalidraw).
- Chromium-only features silently missing elsewhere (Local Font Access) — detect and explain.
- "Text editing" that fragments lines into boxes or substitutes fonts silently (LibreOffice, Canva) — surface reflow risk before the user commits.
- Signatures that look official but are only images (Firefox disclaimer) — label clearly.
- Annotations stored in proprietary sidecars (Xournal++) — always write standard PDF annots.

---

## Key takeaways for the founder

1. The thesis is well supported: the market is split between quota/paywall SaaS that uploads your files and OSS toolkits with cluttered tool-grid UIs; the two biggest OSS players both alienated self-hosters with telemetry/banners/licensing pivots, and Stirling just introduced *metering* in a self-hosted app (v3.0.0, Sept 2026).
2. The bar has risen fast in 2026: Firefox 150 now does local page reorder/delete/export; Chrome 145 does annotations; BentoPDF does client-side text editing (Chromium only). "Merge + annotate locally" alone is no longer differentiating — the differentiator must be **one coherent, keyboard-first document workspace** (multi-doc, page grid, history, command palette) with **provable privacy and zero monetisation friction**.
3. Best engine path for a permissive-licence, fully client-side editor: PDFium WASM (EmbedPDF's Apache-2.0 runtime or `@hyzyla/pdfium`) for render/annotate/redact, pdf-lib or pdfcpu-wasm for page assembly, qpdf-wasm for structure/compression, Tesseract-wasm for OCR — all in Workers, all bundled, none from CDNs. Avoid MuPDF unless you accept AGPL for the whole app.
4. Merge-with-drag-reorder is correctly mandatory for v1, and the PDF Arranger / Preview "light table" is the model users already love; make it multi-source and keyboard-operable and it will be the best implementation on the web.

# Security policy

pdf-editor runs entirely in the browser. There is no server, no account system and no
upload: documents are processed locally in Web Workers and never leave the device. That
shapes what a vulnerability looks like here.

## Reporting a vulnerability

Report vulnerabilities **privately** through
[GitHub Security Advisories](https://github.com/ErenDenizK/pdf-editor/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). Please do not open a public
issue, discussion or pull request for a suspected vulnerability.

Include, where possible:

- a description of the issue and its impact;
- steps to reproduce, and the browser and operating system used;
- a proof-of-concept PDF (minimal, and free of real personal data).

We aim to acknowledge a report within 7 days and to agree on a disclosure timeline with
you. Credit is given in the advisory unless you prefer otherwise.

## Supported versions

Only the latest deployment of `main` is supported. The project is pre-1.0; fixes are not
backported.

## Scope

In scope:

- **Malformed or hostile PDFs** that crash, hang or exhaust memory in a worker in a way
  that takes down the application, corrupts other open documents, or executes code.
- **Data leakage between documents**: content, metadata, form values or redacted material
  from one document appearing in another, in an export, or in persistent storage
  (OPFS, IndexedDB, caches) beyond what the user chose to keep.
- **Incomplete redaction**: redacted content that remains recoverable from an exported
  file.
- **Content Security Policy bypass**: any way for document content or a crafted file to
  execute script, load remote resources, or make network requests despite the CSP.
- Anything that causes the application to send document data off the device.

Out of scope:

- Vulnerabilities in browsers themselves, or in extensions the user installed.
- Attacks that require a compromised device or a malicious browser.
- Denial of service limited to the single tab that opened a deliberately huge document,
  when the application reports the failure honestly.
- Findings about GitHub Pages hosting headers that the project cannot configure
  (see ADR-0004).

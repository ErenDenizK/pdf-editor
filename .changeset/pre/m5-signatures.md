---
"@pdf-editor/web": minor
"@pdf-editor/engine": minor
---

Digital signatures: sources with signatures are checked on open in a signature worker and
shown as Intact, Intact but changed later, Changed after signing, Broken or Cannot check,
with the signer facts, the claimed time and the later changes by revision; the app never
says "valid" and states that identity and trust are not verified. Sign… adds one PAdES-B
approval signature with a local PKCS#12 file as the last export step; existing signatures
are stripped on export because every export rewrites the file, and the dialog says so.

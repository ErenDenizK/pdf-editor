---
"@pdf-editor/web": minor
"@pdf-editor/engine": minor
"@pdf-editor/document-model": minor
---

Recognize text (OCR): scanned pages get an invisible, searchable text layer written over
the untouched page image with Tesseract (nine language packs served from the app's own
origin and downloaded on demand, nothing leaves the browser). Each page reports its quality
as Good, Review, Poor or No text found, low-confidence words are listed for review, and the
run is one undoable history entry whose replay never recognises again.

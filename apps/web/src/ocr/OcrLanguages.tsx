/**
 * OCR languages (spec recognize-and-compare §1.1, §1.5; ADR-0012 §3–§4): the packs served
 * from our origin with their size and whether they are on this device, a "Keep available
 * offline" switch per pack, the imported packs with Remove, and "Import language file…".
 *
 * "Keep available offline" is the `pdf-editor-ocr` Cache Storage cache the service worker
 * serves OCR files from (CacheFirst): switching it on downloads the pack (and the engine
 * files this browser needs) into it, switching it off deletes the pack from it. A pack used
 * once is kept there too, so the switch shows what is on the device. Imported files
 * (`.traineddata` or `.traineddata.gz`, never a URL) are checked to be Tesseract language
 * files and kept in the origin-private file system; one named like a served pack overrides it.
 */
import type { OcrLanguagePack } from '@pdf-editor/engine';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

import { toFailure } from '../engine/engine-service';
import { getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import toolStyles from '../tools/ToolDialog.module.css';
import styles from './Ocr.module.css';
import { ocrDependencies } from './ocr-deps';
import { formatMegabytes, languageName } from './ocr-model';

type Busy = { readonly code: string; readonly done: number; readonly total: number } | null;

/** A failure of the pack store as a sentence in the UI language. */
function importError(error: unknown): string {
  const failure = toFailure(error);
  if (failure.code === 'corrupt') return m.ocr_import_not_traineddata();
  if (failure.code === 'unsupported' && failure.message.includes('named like')) {
    return m.ocr_import_bad_name();
  }
  return m.ocr_import_failed({ reason: failure.message });
}

export function OcrLanguages({ onBack }: { readonly onBack: (() => void) | undefined }) {
  const [packs, setPacks] = useState<readonly OcrLanguagePack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const input = useRef<HTMLInputElement>(null);
  const locale = getLocale();

  // Bumped to read the list again after a change.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    let live = true;
    ocrDependencies()
      .packs()
      .then((store) => store.list())
      .then(
        (list) => {
          if (live) setPacks(list);
        },
        (failure: unknown) => {
          if (live) setError(m.ocr_packs_failed({ reason: toFailure(failure).message }));
        },
      );
    return () => {
      live = false;
    };
  }, [version]);

  const keepOffline = async (pack: OcrLanguagePack, keep: boolean) => {
    setError(null);
    setBusy({ code: pack.code, done: 0, total: pack.downloadBytes });
    try {
      const deps = ocrDependencies();
      const store = await deps.packs();
      await store.keepOffline([pack.code], keep, keep ? await deps.engineFiles() : [], {
        onProgress: (done, total) => setBusy({ code: pack.code, done, total }),
      });
      announce(
        keep
          ? m.ocr_pack_kept({ name: languageName(pack.code, locale) })
          : m.ocr_pack_removed({ name: languageName(pack.code, locale) }),
      );
    } catch (failure) {
      setError(m.ocr_pack_offline_failed({ reason: toFailure(failure).message }));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const remove = async (pack: OcrLanguagePack) => {
    setError(null);
    try {
      await (await ocrDependencies().packs()).remove(pack.code);
      announce(m.ocr_pack_removed({ name: languageName(pack.code, locale) }));
    } catch (failure) {
      setError(m.ocr_pack_offline_failed({ reason: toFailure(failure).message }));
    } finally {
      refresh();
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const pack = await (await ocrDependencies().packs()).importFile(file, file.name);
      announce(m.ocr_pack_imported({ name: languageName(pack.code, locale) }));
    } catch (failure) {
      setError(importError(failure));
    } finally {
      refresh();
    }
  };

  return (
    <div className={`${toolStyles.body} ${styles.body}`} data-testid="ocr-languages">
      <p className={toolStyles.description}>{m.ocr_languages_intro()}</p>
      {packs === null && error === null ? (
        <p className={toolStyles.hint} role="status">
          {m.ocr_languages_loading()}
        </p>
      ) : null}
      <p className={styles.packsHeader} aria-hidden="true">
        <span>{m.ocr_languages()}</span>
        <span>{m.ocr_pack_offline()}</span>
      </p>
      <ul className={styles.packs} aria-label={m.ocr_languages_title()}>
        {(packs ?? []).map((pack) => {
          const name = languageName(pack.code, locale);
          const working = busy?.code === pack.code;
          return (
            <li key={pack.code} className={styles.pack} data-testid="ocr-pack">
              <span className={styles.packText}>
                <span className={styles.packName}>
                  {name}
                  <span className={styles.code}>{pack.code}</span>
                </span>
                <span className={styles.meta}>
                  {working && busy
                    ? m.ocr_phase_download({
                        done: formatMegabytes(busy.done, locale),
                        total: formatMegabytes(busy.total, locale),
                      })
                    : pack.source === 'imported'
                      ? m.ocr_pack_imported_state({ size: formatMegabytes(pack.bytes, locale) })
                      : pack.onDevice
                        ? m.ocr_pack_on_device({ size: formatMegabytes(pack.bytes, locale) })
                        : m.ocr_pack_downloads({
                            size: formatMegabytes(pack.downloadBytes, locale),
                          })}
                </span>
              </span>
              {pack.source === 'imported' ? (
                <button
                  type="button"
                  className={toolStyles.secondary}
                  aria-label={m.ocr_pack_remove_label({ name })}
                  onClick={() => void remove(pack)}
                >
                  {m.ocr_pack_remove()}
                </button>
              ) : (
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={pack.onDevice}
                    disabled={busy !== null}
                    aria-label={m.ocr_pack_offline_label({ name })}
                    onChange={(event) => void keepOffline(pack, event.target.checked)}
                  />
                  <span className="visually-hidden">{m.ocr_pack_offline()}</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className={toolStyles.error} role="alert">
          {error}
        </p>
      ) : null}
      <p className={toolStyles.hint}>{m.ocr_import_hint()}</p>
      <input
        ref={input}
        type="file"
        accept=".traineddata,.gz,application/gzip,application/octet-stream"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void importFile(event)}
        data-testid="ocr-import-input"
      />
      <div className={toolStyles.actions}>
        {onBack ? (
          <button type="button" className={toolStyles.secondary} onClick={onBack}>
            {m.ocr_back()}
          </button>
        ) : null}
        <span className={toolStyles.spacer} />
        <button
          type="button"
          className={toolStyles.secondary}
          onClick={() => input.current?.click()}
        >
          {m.ocr_import()}
        </button>
      </div>
    </div>
  );
}

/**
 * Editable document metadata in the Info section (spec document-tools.md §3): Title,
 * Author, Subject, Keywords, Creator, Language (BCP 47, suggestions plus free text), the
 * creation date (read-only) and custom Info keys. A field commits on Enter or when it
 * loses focus; each change is one history entry and switches the export policy to
 * "explicit" (`setMetadata`). Escape restores the stored value.
 */
import {
  customKeyProblem,
  type DocumentMetadata,
  isLanguageTag,
  type MetadataPatch,
  type MetadataTextField,
  setMetadata,
  type VirtualDocument,
} from '@pdf-editor/document-model';
import { X } from 'lucide-react';
import { type KeyboardEvent, type SyntheticEvent, useId, useState } from 'react';

import { getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import { useWorkspaceStore } from '../state/workspace-store';
import styles from './DocumentTools.module.css';

/** Suggestions for the language field; any well-formed BCP 47 tag is accepted. */
export const COMMON_LANGUAGE_TAGS = [
  'en',
  'en-US',
  'en-GB',
  'de',
  'de-DE',
  'fr',
  'fr-FR',
  'es',
  'es-ES',
  'it',
  'pt',
  'pt-BR',
  'nl',
  'sv',
  'da',
  'nb',
  'fi',
  'pl',
  'cs',
  'hu',
  'ro',
  'tr',
  'tr-TR',
  'el',
  'ru',
  'uk',
  'ar',
  'he',
  'hi',
  'ja',
  'ko',
  'zh-Hans',
  'zh-Hant',
] as const;

const TEXT_FIELDS: readonly Exclude<MetadataTextField, 'language'>[] = [
  'title',
  'author',
  'subject',
  'keywords',
  'creator',
];

function fieldLabel(field: MetadataTextField): string {
  switch (field) {
    case 'title':
      return m.meta_title();
    case 'author':
      return m.meta_author();
    case 'subject':
      return m.meta_subject();
    case 'keywords':
      return m.meta_keywords();
    case 'creator':
      return m.meta_creator();
    case 'language':
      return m.meta_language();
  }
}

function languageName(tag: string): string | undefined {
  try {
    const name = new Intl.DisplayNames([getLocale()], { type: 'language' }).of(tag);
    return name && name !== tag ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Commits a metadata change as one history entry; false when nothing changed. */
export function commitMetadata(
  documentId: VirtualDocument['id'],
  patch: MetadataPatch,
  label: string,
): boolean {
  return useWorkspaceStore
    .getState()
    .applyOperation((ws) => setMetadata(ws, documentId, patch), label);
}

function policyText(meta: DocumentMetadata): string {
  if (meta.strip !== undefined) return m.meta_policy_strip();
  return meta.policy === 'explicit' ? m.meta_policy_explicit() : m.meta_policy_inherit();
}

export function MetadataEditor({ doc }: { readonly doc: VirtualDocument }) {
  const meta = doc.metadata;
  const created = meta.creationDate === undefined ? undefined : new Date(meta.creationDate);
  const listId = useId();
  return (
    <div className={styles.metadata} data-testid="metadata-editor">
      <p className={styles.note} data-testid="metadata-policy">
        {policyText(meta)}
      </p>
      <div className={styles.fields}>
        {TEXT_FIELDS.map((field) => (
          <TextField
            key={`${doc.id}:${field}:${meta[field] ?? ''}`}
            label={fieldLabel(field)}
            value={meta[field] ?? ''}
            onCommit={(value) =>
              commitMetadata(
                doc.id,
                { [field]: value },
                m.history_metadata({ field: fieldLabel(field) }),
              )
            }
          />
        ))}
        <TextField
          key={`${doc.id}:language:${meta.language ?? ''}`}
          label={fieldLabel('language')}
          value={meta.language ?? ''}
          list={listId}
          validate={(value) =>
            value === '' || isLanguageTag(value) ? undefined : m.meta_language_invalid()
          }
          hint={meta.language ? languageName(meta.language) : undefined}
          onCommit={(value) =>
            commitMetadata(
              doc.id,
              { language: value },
              m.history_metadata({ field: fieldLabel('language') }),
            )
          }
        />
        <datalist id={listId}>
          {COMMON_LANGUAGE_TAGS.map((tag) => (
            <option key={tag} value={tag} label={languageName(tag) ?? tag} />
          ))}
        </datalist>
        <span className={styles.fieldLabel}>{m.meta_created()}</span>
        <span className={styles.readonly} data-testid="metadata-created">
          {created && !Number.isNaN(created.getTime())
            ? new Intl.DateTimeFormat(getLocale(), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(created)
            : '—'}
        </span>
      </div>
      <CustomKeys doc={doc} />
    </div>
  );
}

function TextField({
  label,
  value,
  onCommit,
  validate,
  list,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly validate?: (value: string) => string | undefined;
  readonly list?: string;
  readonly hint?: string | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | undefined>();
  const id = useId();
  const commit = () => {
    const next = draft.trim();
    if (next === value) {
      setError(undefined);
      return;
    }
    const problem = validate?.(next);
    setError(problem);
    if (problem === undefined) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape' && draft !== value) {
      event.preventDefault();
      event.stopPropagation();
      setDraft(value);
      setError(undefined);
    }
  };
  return (
    <>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <span className={styles.fieldControl}>
        <input
          id={id}
          className={styles.input}
          value={draft}
          list={list}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {error ? (
          <span id={`${id}-error`} className={styles.error}>
            {error}
          </span>
        ) : hint ? (
          <span className={styles.hint}>{hint}</span>
        ) : null}
      </span>
    </>
  );
}

function keyProblemText(problem: NonNullable<ReturnType<typeof customKeyProblem>>): string {
  switch (problem) {
    case 'empty':
      return m.meta_key_empty();
    case 'invalid':
      return m.meta_key_invalid();
    case 'reserved':
      return m.meta_key_reserved();
    case 'duplicate':
      return m.meta_key_duplicate();
    case 'too-long':
      return m.meta_key_too_long();
  }
}

function CustomKeys({ doc }: { readonly doc: VirtualDocument }) {
  const custom = doc.metadata.custom ?? {};
  const keys = Object.keys(custom);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const keyId = useId();
  const add = (event: SyntheticEvent) => {
    event.preventDefault();
    const name = key.trim();
    const problem = customKeyProblem(name, keys);
    if (problem !== undefined) {
      setError(keyProblemText(problem));
      return;
    }
    if (
      commitMetadata(
        doc.id,
        { custom: { ...custom, [name]: value } },
        m.history_metadata_key_add({ key: name }),
      )
    ) {
      announce(m.announce_metadata_key_added({ key: name }));
    }
    setKey('');
    setValue('');
    setError(undefined);
  };
  return (
    <div className={styles.custom}>
      <h3 className={styles.subheading}>{m.meta_custom()}</h3>
      {keys.length > 0 ? (
        <div className={styles.fields}>
          {keys.map((name) => (
            <CustomRow
              key={`${doc.id}:${name}:${custom[name] ?? ''}`}
              name={name}
              value={custom[name] ?? ''}
              onCommit={(next) =>
                commitMetadata(
                  doc.id,
                  { custom: { ...custom, [name]: next } },
                  m.history_metadata({ field: name }),
                )
              }
              onRemove={() => {
                const { [name]: _removed, ...rest } = custom;
                if (
                  commitMetadata(
                    doc.id,
                    { custom: rest },
                    m.history_metadata_key_remove({ key: name }),
                  )
                ) {
                  announce(m.announce_metadata_key_removed({ key: name }));
                }
              }}
            />
          ))}
        </div>
      ) : (
        <p className={styles.note}>{m.meta_custom_empty()}</p>
      )}
      <form className={styles.addKey} onSubmit={add} aria-label={m.meta_custom_add_label()}>
        <input
          id={keyId}
          className={styles.input}
          placeholder={m.meta_custom_key()}
          aria-label={m.meta_custom_key()}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${keyId}-error` : undefined}
          value={key}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setKey(event.target.value);
            setError(undefined);
          }}
        />
        <input
          className={styles.input}
          placeholder={m.meta_custom_value()}
          aria-label={m.meta_custom_value()}
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className={styles.small} disabled={key.trim() === ''}>
          {m.meta_custom_add()}
        </button>
        {error ? (
          <span id={`${keyId}-error`} className={styles.error} role="alert">
            {error}
          </span>
        ) : null}
      </form>
    </div>
  );
}

function CustomRow({
  name,
  value,
  onCommit,
  onRemove,
}: {
  readonly name: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly onRemove: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  return (
    <>
      <label className={styles.fieldLabel} htmlFor={id} title={name}>
        {name}
      </label>
      <span className={styles.fieldRow}>
        <input
          id={id}
          className={styles.input}
          value={draft}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft !== value) onCommit(draft);
            if (event.key === 'Escape' && draft !== value) {
              event.stopPropagation();
              setDraft(value);
            }
          }}
        />
        <button
          type="button"
          className={styles.iconButton}
          aria-label={m.meta_custom_remove({ key: name })}
          title={m.meta_custom_remove({ key: name })}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      </span>
    </>
  );
}

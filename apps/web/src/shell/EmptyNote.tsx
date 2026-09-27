import styles from './EmptyNote.module.css';

/** The quiet two-line empty state used inside panels. */
export function EmptyNote({ title, body }: { readonly title: string; readonly body?: string }) {
  return (
    <div className={styles.note}>
      <p className={styles.title}>{title}</p>
      {body ? <p className={styles.body}>{body}</p> : null}
    </div>
  );
}

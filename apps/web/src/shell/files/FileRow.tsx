/**
 * One open document in compact form (experience-redesign §4.1, the Files tab): the tag dot,
 * the name, "12 pages · 2.8 MB", the active marker and a close button. A plain row over
 * plain props, so Home's list form can use it too.
 */
import { X } from 'lucide-react';

import { formatBytes } from '../../files/file-filters';
import { m } from '../../i18n';
import { IconButton } from '../../ui/IconButton';
import styles from './FileRow.module.css';

export interface FileRowProps {
  readonly name: string;
  readonly pages: number;
  /** Bytes of the file(s) as opened. */
  readonly size: number;
  /** Index into the tag colours (`data-tag`). */
  readonly tag: number;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

export function FileRow({ name, pages, size, tag, active, onOpen, onClose }: FileRowProps) {
  const meta = m.nav_files_meta({
    pages: m.pages_count({ count: pages }),
    size: formatBytes(size),
  });
  return (
    <li className={styles.row} aria-current={active ? 'true' : undefined} data-file-row="">
      <button type="button" className={styles.open} title={name} onClick={onOpen}>
        <span className={styles.tag} data-tag={tag} aria-hidden="true" />
        <span className={styles.text}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>{meta}</span>
        </span>
      </button>
      <IconButton
        label={m.nav_files_close({ name })}
        icon={<X />}
        tooltipSide="right"
        className={styles.close}
        onClick={onClose}
      />
    </li>
  );
}

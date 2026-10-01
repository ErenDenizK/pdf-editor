/**
 * A row of choice chips with radio semantics (`role="radiogroup"`): one tab stop on the
 * chosen chip, arrow keys (and Home / End) move to a neighbour and choose it, as the APG
 * radio group does. Used by the Review filter chips and the Pages tab's Pages · Bookmarks
 * switch.
 */
import { type KeyboardEvent, useRef } from 'react';

import styles from './RadioChips.module.css';

export interface RadioChip<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Shown after the label in tabular numerals. */
  readonly count?: string | undefined;
  /** The accessible name when it should say more than the label ("Marks, 2 items"). */
  readonly name?: string | undefined;
}

export function RadioChips<T extends string>({
  label,
  chips,
  value,
  onChange,
  className,
}: {
  readonly label: string;
  readonly chips: readonly RadioChip<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly className?: string | undefined;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const index = chips.findIndex((chip) => chip.value === value);
    if (index < 0) return;
    event.preventDefault();
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    let next = index;
    if (forward) next = (index + 1) % chips.length;
    if (back) next = (index - 1 + chips.length) % chips.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = chips.length - 1;
    const chip = chips[next];
    if (!chip) return;
    onChange(chip.value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={[styles.group, className].filter(Boolean).join(' ')}
    >
      {chips.map((chip) => {
        const checked = chip.value === value;
        return (
          <button
            key={chip.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={chip.name}
            tabIndex={checked ? 0 : -1}
            className={styles.chip}
            data-value={chip.value}
            onKeyDown={onKeyDown}
            onClick={() => {
              if (!checked) onChange(chip.value);
            }}
          >
            <span>{chip.label}</span>
            {chip.count !== undefined ? <span className={styles.count}>{chip.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The announcer's rules (experience-redesign §10): one live message per task, said once,
 * a keyed message replacing its kind, and the assertive channel for unseen failures.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { announce, useAnnouncer } from './announcer';

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(async () => {
  await tick();
  useAnnouncer.setState({ message: '', serial: 0, alert: '', alertSerial: 0 });
});

describe('announce', () => {
  it('says one message, and the same words again in a later task', async () => {
    announce('Draw tools');
    expect(useAnnouncer.getState()).toMatchObject({ message: 'Draw tools', serial: 1 });
    await tick();
    announce('Draw tools');
    expect(useAnnouncer.getState()).toMatchObject({ message: 'Draw tools', serial: 2 });
  });

  it('joins what one change causes, in order, each once', () => {
    announce('Pen: 5 strokes on page 1');
    announce('Lasso tool');
    announce('Lasso tool');
    expect(useAnnouncer.getState().message).toBe('Pen: 5 strokes on page 1. Lasso tool');
  });

  it('lets a keyed message replace an earlier one of its key, not the others', () => {
    announce('Pen: 2 strokes on page 1');
    announce('Pen tool', { key: 'tool' });
    announce('Blue pen, 1.5 pt', { key: 'tool' });
    expect(useAnnouncer.getState().message).toBe('Pen: 2 strokes on page 1. Blue pen, 1.5 pt');
  });

  it('starts afresh in the next task', async () => {
    announce('2 files selected');
    await tick();
    announce('3 files selected');
    expect(useAnnouncer.getState().message).toBe('3 files selected');
  });

  it('keeps failures on the assertive channel, apart from the polite one', () => {
    announce('Draw tools');
    announce('Stroke not saved', { politeness: 'assertive' });
    expect(useAnnouncer.getState()).toMatchObject({
      message: 'Draw tools',
      alert: 'Stroke not saved',
      alertSerial: 1,
    });
  });
});

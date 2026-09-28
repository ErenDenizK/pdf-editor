/** "Export changes as text": downloads the Changes list as a Markdown file. */
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { deliverFile } from '../tools/deliver-file';
import { buildChangeList } from './changes';
import { changesMarkdown } from './changes-text';
import { comparedStem } from './compare-runner';
import { useCompareStore } from './compare-store';

/** Names of the compared tabs that were read from their assembled copy. */
export function assembledNames(): string[] {
  const { sides } = useCompareStore.getState();
  if (!sides) return [];
  return [sides.a, sides.b].filter((s) => s.assembled).map((s) => s.name);
}

export async function exportChangesText(): Promise<void> {
  const { result } = useCompareStore.getState();
  if (!result) return;
  const text = changesMarkdown(result, buildChangeList(result), assembledNames());
  const name = `${comparedStem()}-changes.md`;
  const outcome = await deliverFile(
    new Blob([text], { type: 'text/markdown' }),
    name,
    'text/markdown',
  );
  if (outcome === 'cancelled') return;
  announce(outcome === 'saved' ? m.announce_saved({ name }) : m.announce_downloaded({ name }));
}

/**
 * Where the media tool reads and writes. Everything under `out/` is generated and
 * gitignored: per-scene working files in `out/<id>/`, the publishable files in
 * `out/media/` (what the deploy job copies to the site's `media/`), and the run's request
 * log in `out/requests.log`.
 */
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

export const TOOL_DIR = fileURLToPath(root);
export const OUT_DIR = fileURLToPath(new URL('out/', root));
export const MEDIA_DIR = fileURLToPath(new URL('out/media/', root));
export const REQUEST_LOG = fileURLToPath(new URL('out/requests.log', root));
export const BUDGETS_FILE = fileURLToPath(new URL('budgets.json', root));

/** The working directory of one scene. */
export function sceneDir(id: string): string {
  return fileURLToPath(new URL(`out/${id}/`, root));
}

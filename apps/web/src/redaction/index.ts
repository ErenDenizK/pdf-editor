/**
 * Redaction marks (M4, redaction spec §1.1): the Redact tool's page layer, marks as
 * /Redact annotations, the pattern helpers and the Redactions panel's state. Importing
 * this module registers the page layer after the annotation layer.
 */
import '../annotations';

import { registerPageOverlay } from '../stage/page-overlays';
import { RedactionLayer } from './RedactionLayer';

export { registerRedactionCommands, showRedactionsPanel } from './commands';
export { createMarks, markSelection } from './marks';
export {
  clearFinder,
  deleteMark,
  findSensitiveData,
  isStaleMatch,
  markCheckedFinds,
  markSearchHits,
  revealMark,
  stepMark,
} from './review';

registerPageOverlay(RedactionLayer);

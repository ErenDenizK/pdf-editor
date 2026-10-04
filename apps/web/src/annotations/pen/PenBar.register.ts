/**
 * Plugs the pen presets into the tool bar (experience-redesign spec §6.2): the Draw group's
 * Pen button becomes the four presets, the options tier holds the pen's note, and the
 * eraser's tier its mode and size. Called once by the app root; returns the disposer that
 * restores the bar's defaults.
 */
import { registerPenSlots } from '../../shell/FloatingToolbar.slots';
import { EraserTier, PenBar, PenTier } from './PenBar';

export function registerPenBar(): () => void {
  return registerPenSlots({ Bar: PenBar, Tier: PenTier, EraserTier });
}

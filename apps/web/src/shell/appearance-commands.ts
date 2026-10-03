/**
 * Palette commands for the appearance settings (spec craft §7): "Glass panels" and "Reduce
 * transparency" toggle and say the new state. The Document menu shows the same two settings
 * as checkbox items (`tools/DocumentMenu.tsx`).
 */
import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useAppearanceStore } from '../state/appearance-store';
import { announce } from './announcer';

/** Turns Glass panels on or off and announces it. */
export function setGlassPanels(on: boolean): void {
  useAppearanceStore.getState().setGlassPanels(on);
  announce(on ? m.announce_glass_panels_on() : m.announce_glass_panels_off());
}

/** Turns Reduce transparency on or off and announces it. */
export function setReduceTransparency(on: boolean): void {
  useAppearanceStore.getState().setReduceTransparency(on);
  announce(on ? m.announce_reduce_transparency_on() : m.announce_reduce_transparency_off());
}

/** Found in either UI language, as the language commands are. */
const SHARED_KEYWORDS = ['appearance', 'settings', 'görünüm', 'ayarlar'] as const;

export function registerAppearanceCommands(registry: CommandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'view.glassPanels',
      title: m.cmd_view_glass_panels(),
      group: m.group_view(),
      keywords: [...SHARED_KEYWORDS, 'glass', 'frosted', 'blur', 'panels', 'cam', 'buzlu'],
      run: () => setGlassPanels(!useAppearanceStore.getState().glassPanels),
    }),
    registry.register({
      id: 'view.reduceTransparency',
      title: m.cmd_view_reduce_transparency(),
      group: m.group_view(),
      keywords: [...SHARED_KEYWORDS, 'transparency', 'opaque', 'solid', 'saydamlık', 'opak'],
      run: () => setReduceTransparency(!useAppearanceStore.getState().reduceTransparency),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

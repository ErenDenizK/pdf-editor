/**
 * The About dialog (ADR-0017 §6): its fields in order, the "Public beta" label only for a
 * pre-release, the palette command and the privacy popover's version line as openers.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { registerAppCommands } from '../../commands/app-commands';
import { CommandRegistry } from '../../commands/registry';
import { setLocale } from '../../i18n';
import { PrivacyIndicator } from '../../privacy/PrivacyIndicator';
import { usePwaStore } from '../../pwa/register';
import { closeAbout, openAbout, useAboutStore } from './about-store';
import { AboutDialog } from './AboutDialog';
import { BUILD_INFO, makeBuildInfo } from './build-info';

const BETA = makeBuildInfo('1.0.0-beta.0', 'abc1234', '2026-10-01T12:00:00.000Z');
const RELEASE = makeBuildInfo('1.0.0', 'def5678', '2026-10-01T12:00:00.000Z');

const dialog = () => screen.getByTestId('about-dialog');

let estimate: MockInstance<StorageManager['estimate']>;

beforeEach(() => {
  closeAbout();
  usePwaStore.setState({ status: 'ready', updateAvailable: false });
  estimate = vi.spyOn(navigator.storage, 'estimate').mockResolvedValue({
    usage: 5 * 1024 * 1024,
    quota: 1024 ** 3,
  });
});

afterEach(() => {
  act(() => closeAbout());
  vi.restoreAllMocks();
  setLocale('en');
});

describe('About dialog', () => {
  it('shows every field, in order, for a pre-release', async () => {
    render(<AboutDialog info={BETA} />);
    act(() => openAbout());
    const popup = await screen.findByTestId('about-dialog');

    expect(within(popup).getByRole('heading', { name: 'PDF Editor' })).toBeInTheDocument();
    expect(within(popup).getByTestId('about-prerelease')).toHaveTextContent('Public beta');
    expect(within(popup).getByTestId('about-version')).toHaveTextContent('1.0.0-beta.0');
    expect(within(popup).getByTestId('about-commit')).toHaveTextContent('abc1234');
    expect(within(popup).getByTestId('about-build-date')).toHaveTextContent('October 1, 2026');

    const notes = within(popup).getByRole('link', { name: /Release notes/ });
    expect(notes).toHaveAttribute(
      'href',
      'https://github.com/ErenDenizK/pdf-editor/releases/tag/v1.0.0-beta.0',
    );
    const source = within(popup).getByRole('link', { name: /Source/ });
    expect(source).toHaveAttribute('href', 'https://github.com/ErenDenizK/pdf-editor');
    for (const link of [notes, source]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
      expect(link).toHaveAccessibleName(/opens in a new tab/);
    }
    expect(within(popup).getByTestId('about-license')).toHaveTextContent('Apache-2.0');
    expect(popup).toHaveAccessibleDescription('Files never leave your device.');
    await waitFor(() =>
      expect(within(popup).getByTestId('about-storage')).toHaveTextContent('5.0 MB'),
    );
    expect(estimate).toHaveBeenCalled();
    expect(within(popup).getByTestId('about-offline')).toHaveTextContent(
      'Installed · works offline',
    );

    // Reading order: name, label, version, build, notes, licence, statement, storage, offline.
    const text = popup.textContent ?? '';
    const order = [
      'PDF Editor',
      'Public beta',
      '1.0.0-beta.0',
      'abc1234',
      'October 1, 2026',
      'Release notes',
      'Apache-2.0',
      'Source',
      'Files never leave your device.',
      '5.0 MB',
      'Installed · works offline',
    ].map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('has no "Public beta" label for a release', async () => {
    render(<AboutDialog info={RELEASE} />);
    act(() => openAbout());
    await screen.findByTestId('about-dialog');
    expect(screen.queryByTestId('about-prerelease')).toBeNull();
    expect(screen.queryByText('Public beta')).toBeNull();
    expect(screen.getByTestId('about-version')).toHaveTextContent('1.0.0');
    expect(screen.getByRole('link', { name: /Release notes/ })).toHaveAttribute(
      'href',
      'https://github.com/ErenDenizK/pdf-editor/releases/tag/v1.0.0',
    );
  });

  it('says so when the browser cannot estimate storage', async () => {
    estimate.mockRejectedValue(new Error('blocked'));
    render(<AboutDialog info={RELEASE} />);
    act(() => openAbout());
    await waitFor(() =>
      expect(screen.getByTestId('about-storage')).toHaveTextContent(
        'Not available in this browser.',
      ),
    );
  });

  it('formats the build date in the UI language', async () => {
    setLocale('tr');
    render(<AboutDialog info={BETA} />);
    act(() => openAbout());
    await screen.findByTestId('about-dialog');
    expect(screen.getByTestId('about-build-date')).toHaveTextContent('1 Ekim 2026');
    expect(screen.getByTestId('about-prerelease')).toHaveTextContent('Açık beta');
    expect(screen.getByTestId('about-dialog')).toHaveAccessibleDescription(
      'Dosyalar cihazınızdan asla çıkmaz.',
    );
  });

  it('opens from the palette command and closes on Escape, returning focus', async () => {
    const registry = new CommandRegistry();
    const dispose = registerAppCommands(registry);
    try {
      const command = registry.get('help.about');
      expect(command?.title).toBe('About PDF Editor');
      render(
        <>
          <button type="button">Opener</button>
          <AboutDialog info={BETA} />
        </>,
      );
      const opener = screen.getByRole('button', { name: 'Opener' });
      opener.focus();
      await act(() => registry.execute('help.about'));
      await screen.findByTestId('about-dialog');
      await waitFor(() => expect(dialog()).toContainElement(document.activeElement as HTMLElement));

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(useAboutStore.getState().open).toBe(false));
      await waitFor(() => expect(screen.queryByTestId('about-dialog')).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      dispose();
    }
  });

  it('opens from the version line in the privacy popover and returns focus to it', async () => {
    render(
      <>
        <PrivacyIndicator />
        <AboutDialog />
      </>,
    );
    const trigger = screen.getByTestId('privacy-indicator');
    await userEvent.click(trigger);
    const version = await screen.findByTestId('privacy-version');
    expect(version).toHaveTextContent(`Version ${BUILD_INFO.version}`);

    await userEvent.click(version);
    await screen.findByTestId('about-dialog');
    await waitFor(() => expect(screen.queryByTestId('privacy-version')).toBeNull());
    await waitFor(() => expect(dialog()).toContainElement(document.activeElement as HTMLElement));
    expect(screen.getByTestId('about-version')).toHaveTextContent(BUILD_INFO.version);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('about-dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

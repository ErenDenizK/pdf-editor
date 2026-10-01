/**
 * The service worker's offline status in words, shared by the privacy popover and the
 * About dialog so both say the same thing.
 */
import { m } from '../i18n';
import type { ServiceWorkerStatus } from './register';

export function serviceWorkerLabel(status: ServiceWorkerStatus, updateAvailable: boolean): string {
  switch (status) {
    case 'unsupported':
      return m.sw_status_unsupported();
    case 'development':
      return m.sw_status_development();
    case 'installing':
      return m.sw_status_installing();
    case 'ready':
      return updateAvailable ? m.sw_status_update() : m.sw_status_ready();
    case 'error':
      return m.sw_status_error();
  }
}

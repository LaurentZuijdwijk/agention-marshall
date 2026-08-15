import { useSyncExternalStore } from 'react';
import type { ConfigService, ConfigSnapshot } from '../services/config-service.js';

/**
 * The current configuration, re-rendering the caller when it changes on disk.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the service is the
 * store, and this hook deliberately keeps no copy of its own. A component that
 * cached the snapshot would be the second source of truth this whole
 * arrangement exists to remove — that is how removing a provider used to leave
 * it on screen.
 */
export function useConfig(service: ConfigService): ConfigSnapshot {
  return useSyncExternalStore(service.subscribe, service.snapshot);
}

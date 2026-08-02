import { useRef, useState } from 'react';

/** Display toggles: `/tokens`, `/stream`, and Ctrl-R. */
export interface Preferences {
  /** Token counts after each response. */
  showUsage: boolean;
  /** Stream tokens live, or show only the finished response. */
  stream: boolean;
  /** Live chain-of-thought, for providers that send it. */
  showReasoning: boolean;
}

const DEFAULTS: Preferences = { showUsage: false, stream: true, showReasoning: false };

export interface PreferencesController extends Preferences {
  /** Flip one toggle and return its new value, for the message that follows. */
  toggle(key: keyof Preferences): boolean;
  /**
   * The same values, readable at event time. The engine client is memoised once
   * and reads preferences when an event lands, not when a render happens — so it
   * would otherwise see whatever was true on the first render, forever.
   */
  read(): Preferences;
}

export function usePreferences(initial: Preferences = DEFAULTS): PreferencesController {
  const [prefs, setPrefs] = useState(initial);

  const current = useRef(prefs);
  current.current = prefs;

  const toggle = (key: keyof Preferences): boolean => {
    const next = !prefs[key];
    setPrefs(prev => ({ ...prev, [key]: next }));
    return next;
  };

  return { ...prefs, toggle, read: () => current.current };
}

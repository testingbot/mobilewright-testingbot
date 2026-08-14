/**
 * Key-chord handling for pressKeys()/clearText(). Chords look like
 * "ctrl+a", "backspace", "meta+shift+z".
 *
 * Android: translated to `mobile: pressKey` keycodes + metastate.
 * iOS: translated to W3C key action sequences with WebDriver unicode keys.
 */

export interface Chord {
  modifiers: string[];
  key: string;
}

export function parseChord(chord: string): Chord {
  // A trailing '+' segment means the literal plus key ("ctrl++", "+").
  const literalPlus = chord === '+' || chord.endsWith('++') || chord.endsWith('+ ');
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  const key = literalPlus ? '+' : (parts.pop() ?? '');
  return { modifiers: parts.map((m) => normalizeModifier(m)), key: key.toLowerCase() };
}

function normalizeModifier(mod: string): string {
  const m = mod.toLowerCase();
  if (m === 'cmd' || m === 'command' || m === 'meta') return 'meta';
  if (m === 'ctrl' || m === 'control') return 'ctrl';
  if (m === 'alt' || m === 'option') return 'alt';
  return m;
}

// ─── Android (mobile: pressKey) ─────────────────────────────────

const ANDROID_KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  up: 19, down: 20, left: 21, right: 22,
  volumeup: 24, volumedown: 25,
  power: 26,
  camera: 27,
  tab: 61,
  space: 62,
  enter: 66,
  backspace: 67,
  delete: 112,
  escape: 111,
  menu: 82,
  search: 84,
  pageup: 92, pagedown: 93,
  appswitch: 187,
};

const ANDROID_META: Record<string, number> = {
  shift: 1,      // META_SHIFT_ON
  alt: 2,        // META_ALT_ON
  ctrl: 4096,    // META_CTRL_ON
  meta: 65536,   // META_META_ON
};

export interface AndroidKeyPress {
  keycode: number;
  metastate?: number;
}

export function toAndroidKeyPress(chord: Chord): AndroidKeyPress {
  let keycode: number | undefined = ANDROID_KEYCODES[chord.key];
  if (keycode === undefined && /^[a-z]$/.test(chord.key)) {
    keycode = 29 + (chord.key.charCodeAt(0) - 97); // KEYCODE_A = 29
  }
  if (keycode === undefined && /^[0-9]$/.test(chord.key)) {
    keycode = 7 + (chord.key.charCodeAt(0) - 48); // KEYCODE_0 = 7
  }
  if (keycode === undefined) {
    throw new Error(`TestingBotDriver: unsupported key "${chord.key}" on Android`);
  }
  const metastate = chord.modifiers.reduce((acc, mod) => {
    const bit = ANDROID_META[mod];
    if (bit === undefined) throw new Error(`TestingBotDriver: unsupported modifier "${mod}" on Android`);
    return acc | bit;
  }, 0);
  return metastate ? { keycode, metastate } : { keycode };
}

// ─── iOS (W3C key actions) ──────────────────────────────────────

const W3C_KEYS: Record<string, string> = {
  shift: '\uE008',
  ctrl: '\uE009',
  alt: '\uE00A',
  meta: '\uE03D',
  enter: '\uE007',
  tab: '\uE004',
  space: ' ',
  backspace: '\uE003',
  delete: '\uE017',
  escape: '\uE00C',
  up: '\uE013', down: '\uE015', left: '\uE012', right: '\uE014',
  pageup: '\uE00E', pagedown: '\uE00F',
  home: '\uE011', end: '\uE010',
};

type W3CAction = Record<string, unknown>;

/** Build one W3C key-input source pressing the given chords in order. */
export function toW3CKeyActions(chords: Chord[]): { type: 'key'; id: string; actions: W3CAction[] }[] {
  const actions: W3CAction[] = [];
  for (const chord of chords) {
    const modifierKeys = chord.modifiers.map((mod) => {
      const key = W3C_KEYS[mod];
      if (!key) throw new Error(`TestingBotDriver: unsupported modifier "${mod}"`);
      return key;
    });
    const key = W3C_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key : undefined);
    if (key === undefined) {
      throw new Error(`TestingBotDriver: unsupported key "${chord.key}"`);
    }
    for (const mod of modifierKeys) actions.push({ type: 'keyDown', value: mod });
    actions.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
    for (const mod of [...modifierKeys].reverse()) actions.push({ type: 'keyUp', value: mod });
  }
  return [{ type: 'key', id: 'keyboard', actions }];
}

/** Type plain text as a W3C key-input source (per-character down/up). */
export function typeTextActions(text: string): { type: 'key'; id: string; actions: W3CAction[] }[] {
  const actions: W3CAction[] = [];
  for (const ch of text) {
    actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
  }
  return [{ type: 'key', id: 'keyboard', actions }];
}

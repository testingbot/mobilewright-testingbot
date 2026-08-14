import { describe, expect, it } from 'vitest';
import { gestureActions, swipeActions, tapActions } from '../../src/actions.js';
import { parseChord, toAndroidKeyPress, toW3CKeyActions } from '../../src/keys.js';

describe('actions', () => {
  it('tap moves, presses, pauses, releases at rounded coordinates', () => {
    const [source] = tapActions(100.4, 200.6);
    expect(source!.actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 100, y: 201, origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 50 },
      { type: 'pointerUp', button: 0 },
    ]);
  });

  it('swipe up from screen center covers half the screen by default', () => {
    const [source] = swipeActions('up', { width: 400, height: 800, scale: 2 });
    const moves = source!.actions.filter((a) => a['type'] === 'pointerMove');
    expect(moves[0]).toMatchObject({ x: 200, y: 400 });
    expect(moves[1]).toMatchObject({ x: 200, y: 0, duration: 300 });
  });

  it('swipe respects start point, distance and duration, clamped to screen', () => {
    const [source] = swipeActions('right', { width: 400, height: 800, scale: 2 }, {
      startX: 350, startY: 100, distance: 200, duration: 500,
    });
    const moves = source!.actions.filter((a) => a['type'] === 'pointerMove');
    expect(moves[1]).toMatchObject({ x: 399, y: 100, duration: 500 });
  });

  it('gesture builds one pointer source per finger with time-derived durations', () => {
    const sources = gestureActions({
      pointers: [
        [{ x: 0, y: 0, time: 0 }, { x: 100, y: 0, time: 250 }],
        [{ x: 50, y: 50 }],
      ],
    });
    expect(sources).toHaveLength(2);
    expect(sources[0]!.actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 0, y: 0, origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 250, x: 100, y: 0, origin: 'viewport' },
      { type: 'pointerUp', button: 0 },
    ]);
  });
});

describe('keys', () => {
  it('parses chords and normalizes modifier aliases', () => {
    expect(parseChord('cmd+shift+z')).toEqual({ modifiers: ['meta', 'shift'], key: 'z' });
    expect(parseChord('Backspace')).toEqual({ modifiers: [], key: 'backspace' });
  });

  it('maps android letters and named keys to keycodes with metastate', () => {
    expect(toAndroidKeyPress(parseChord('ctrl+a'))).toEqual({ keycode: 29, metastate: 4096 });
    expect(toAndroidKeyPress(parseChord('backspace'))).toEqual({ keycode: 67 });
    expect(toAndroidKeyPress(parseChord('7'))).toEqual({ keycode: 14 });
    expect(() => toAndroidKeyPress(parseChord('f13'))).toThrow(/unsupported key/);
  });

  it('wraps W3C key presses in modifier down/up pairs', () => {
    const [source] = toW3CKeyActions([parseChord('meta+a')]);
    expect(source!.actions).toEqual([
      { type: 'keyDown', value: '' },
      { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' },
      { type: 'keyUp', value: '' },
    ]);
  });
});

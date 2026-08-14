import type { GestureSequence, ScreenSize, SwipeDirection, SwipeOptions } from '@mobilewright/protocol';

/**
 * W3C action-sequence builders. Coordinates are passed through in the same
 * space the view hierarchy reports (iOS points, Android pixels) — Appium's
 * input pipeline uses the same space, which is what keeps bounds-center taps
 * landing where the hierarchy says the element is.
 */

type W3CAction = Record<string, unknown>;

interface PointerSource {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: W3CAction[];
}

function pointerSource(id: string, actions: W3CAction[]): PointerSource {
  return { type: 'pointer', id, parameters: { pointerType: 'touch' }, actions };
}

const move = (x: number, y: number, duration = 0): W3CAction =>
  ({ type: 'pointerMove', duration, x: Math.round(x), y: Math.round(y), origin: 'viewport' });
const down = (): W3CAction => ({ type: 'pointerDown', button: 0 });
const up = (): W3CAction => ({ type: 'pointerUp', button: 0 });
const pause = (duration: number): W3CAction => ({ type: 'pause', duration });

export function tapActions(x: number, y: number): PointerSource[] {
  return [pointerSource('finger1', [move(x, y), down(), pause(50), up()])];
}

export function doubleTapActions(x: number, y: number): PointerSource[] {
  return [pointerSource('finger1', [
    move(x, y), down(), pause(50), up(),
    pause(80),
    down(), pause(50), up(),
  ])];
}

export function longPressActions(x: number, y: number, duration = 800): PointerSource[] {
  return [pointerSource('finger1', [move(x, y), down(), pause(duration), up()])];
}

export function swipeActions(
  direction: SwipeDirection,
  screen: ScreenSize,
  opts: SwipeOptions = {},
): PointerSource[] {
  const startX = opts.startX ?? screen.width / 2;
  const startY = opts.startY ?? screen.height / 2;
  const defaultDistance = (direction === 'up' || direction === 'down' ? screen.height : screen.width) * 0.5;
  const distance = opts.distance ?? defaultDistance;
  const duration = opts.duration ?? 300;

  let endX = startX;
  let endY = startY;
  switch (direction) {
    case 'up': endY = startY - distance; break;
    case 'down': endY = startY + distance; break;
    case 'left': endX = startX - distance; break;
    case 'right': endX = startX + distance; break;
  }
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
  endX = clamp(endX, screen.width);
  endY = clamp(endY, screen.height);

  return [pointerSource('finger1', [
    move(startX, startY),
    down(),
    pause(50),
    move(endX, endY, duration),
    pause(50),
    up(),
  ])];
}

/** Multi-finger gesture: each pointer path becomes one W3C input source,
 *  with `time` offsets converted to per-segment move durations. */
export function gestureActions(gestures: GestureSequence): PointerSource[] {
  return gestures.pointers.map((path, i) => {
    if (path.length === 0) return pointerSource(`finger${i + 1}`, []);
    const startTime = path[0]!.time ?? 0;
    const actions: W3CAction[] = [];
    if (startTime > 0) actions.push(pause(startTime)); // staggered finger start
    actions.push(move(path[0]!.x, path[0]!.y), down());
    let lastTime = startTime;
    for (const point of path.slice(1)) {
      const time = point.time ?? lastTime;
      actions.push(move(point.x, point.y, Math.max(time - lastTime, 0)));
      lastTime = time;
    }
    actions.push(up());
    return pointerSource(`finger${i + 1}`, actions);
  });
}

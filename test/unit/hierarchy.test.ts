import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViewNode } from '@mobilewright/protocol';
import { parseHierarchy } from '../../src/hierarchy.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf-8');

function flatten(nodes: ViewNode[]): ViewNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

describe('parseHierarchy (android)', () => {
  const roots = parseHierarchy(fixture('android-page-source.xml'), 'android');
  const all = flatten(roots);

  it('skips the synthetic <hierarchy> wrapper', () => {
    expect(roots).toHaveLength(1);
    expect(roots[0]!.type).toBe('android.widget.FrameLayout');
  });

  it('keeps raw android class names as type', () => {
    expect(all.map((n) => n.type)).toContain('android.widget.Button');
  });

  it('maps text, resource-id, content-desc and hint', () => {
    const input = all.find((n) => n.resourceId === 'com.example.app:id/name_input')!;
    expect(input.label).toBe('Name field');
    expect(input.placeholder).toBe('Your name');
    expect(input.isFocused).toBe(true);

    const button = all.find((n) => n.text === 'Order')!;
    expect(button.resourceId).toBe('com.example.app:id/order_button');
    expect(button.isEnabled).toBe(true);
  });

  it('parses [x1,y1][x2,y2] bounds into x/y/width/height', () => {
    const button = all.find((n) => n.text === 'Order')!;
    expect(button.bounds).toEqual({ x: 380, y: 420, width: 320, height: 120 });
  });

  it('maps displayed to isVisible and checked to isChecked', () => {
    const hidden = all.find((n) => n.text === 'Hidden note')!;
    expect(hidden.isVisible).toBe(false);
    const checkbox = all.find((n) => n.text === 'Extra towel')!;
    expect(checkbox.isChecked).toBe(true);
  });

  it('keeps raw attributes for role heuristics (clickable)', () => {
    const button = all.find((n) => n.text === 'Order')!;
    expect(button.raw?.['clickable']).toBe('true');
  });
});

describe('parseHierarchy (ios)', () => {
  const roots = parseHierarchy(fixture('ios-page-source.xml'), 'ios');
  const all = flatten(roots);

  it('skips the AppiumAUT wrapper and keeps XCUIElementType names', () => {
    expect(roots[0]!.type).toBe('XCUIElementTypeApplication');
    expect(all.map((n) => n.type)).toContain('XCUIElementTypeButton');
  });

  it('maps name to identifier, label, value and placeholderValue', () => {
    const field = all.find((n) => n.identifier === 'name_input')!;
    expect(field.label).toBe('Name field');
    expect(field.placeholder).toBe('Your name');

    const toggle = all.find((n) => n.identifier === 'towel_switch')!;
    expect(toggle.value).toBe('1');
  });

  it('uses point coordinates directly', () => {
    const button = all.find((n) => n.identifier === 'order_button')!;
    expect(button.bounds).toEqual({ x: 130, y: 210, width: 133, height: 50 });
  });

  it('maps visible to isVisible', () => {
    expect(all.find((n) => n.identifier === 'offscreen')!.isVisible).toBe(false);
  });
});

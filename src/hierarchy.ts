import { XMLParser } from 'fast-xml-parser';
import type { Bounds, Platform, ViewNode } from '@mobilewright/protocol';

/**
 * Parse an Appium page-source XML document into the protocol's ViewNode
 * forest. Raw native type strings are passed through verbatim
 * ("android.widget.Button", "XCUIElementTypeButton") — mobilewright-core's
 * role engine normalizes them itself (bareTypeName), and getByType matches
 * case-insensitively on the raw value.
 */
export function parseHierarchy(xml: string, platform: Platform): ViewNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const doc = parser.parse(xml) as OrderedNode[];
  const mapper = platform === 'ios' ? mapIosNode : mapAndroidNode;
  return doc.flatMap((n) => convert(n, mapper));
}

// fast-xml-parser preserveOrder shape: one key per element name, plus ':@' for attributes.
interface OrderedNode {
  ':@'?: Record<string, string>;
  [tag: string]: unknown;
}

type NodeMapper = (tag: string, attrs: Record<string, string>, children: ViewNode[]) => ViewNode | null;

function convert(node: OrderedNode, mapper: NodeMapper): ViewNode[] {
  const tag = Object.keys(node).find((k) => k !== ':@');
  if (!tag || tag === '?xml' || tag === '#text') return [];
  const attrs = node[':@'] ?? {};
  const childNodes = (node[tag] as OrderedNode[] | undefined) ?? [];
  const children = childNodes.flatMap((c) => convert(c, mapper));

  // Both drivers wrap content in a synthetic root ("hierarchy" on Android,
  // "AppiumAUT" on iOS) — skip wrappers, promote their children.
  if (tag === 'hierarchy' || tag === 'AppiumAUT') return children;

  const mapped = mapper(tag, attrs, children);
  return mapped ? [mapped] : children;
}

function mapAndroidNode(tag: string, attrs: Record<string, string>, children: ViewNode[]): ViewNode | null {
  const type = attrs['class'] ?? tag;
  const bounds = parseAndroidBounds(attrs['bounds']);
  const node: ViewNode = {
    type,
    bounds,
    children,
    isVisible: attrs['displayed'] !== 'false',
    isEnabled: attrs['enabled'] !== 'false',
    raw: attrs,
  };
  if (attrs['content-desc']) node.label = attrs['content-desc'];
  if (attrs['resource-id']) node.resourceId = attrs['resource-id'];
  if (attrs['text']) node.text = attrs['text'];
  if (attrs['hint']) node.placeholder = attrs['hint'];
  if (attrs['selected'] !== undefined) node.isSelected = attrs['selected'] === 'true';
  if (attrs['focused'] !== undefined) node.isFocused = attrs['focused'] === 'true';
  if (attrs['checked'] !== undefined) node.isChecked = attrs['checked'] === 'true';
  return node;
}

function mapIosNode(tag: string, attrs: Record<string, string>, children: ViewNode[]): ViewNode | null {
  const type = attrs['type'] ?? tag;
  const node: ViewNode = {
    type,
    bounds: {
      x: num(attrs['x']),
      y: num(attrs['y']),
      width: num(attrs['width']),
      height: num(attrs['height']),
    },
    children,
    isVisible: attrs['visible'] !== 'false',
    isEnabled: attrs['enabled'] !== 'false',
    raw: attrs,
  };
  if (attrs['name']) node.identifier = attrs['name'];
  if (attrs['label']) node.label = attrs['label'];
  if (attrs['value']) node.value = attrs['value'];
  if (attrs['placeholderValue']) node.placeholder = attrs['placeholderValue'];
  if (attrs['selected'] !== undefined) node.isSelected = attrs['selected'] === 'true';
  if (attrs['focused'] !== undefined) node.isFocused = attrs['focused'] === 'true';
  return node;
}

/** Android bounds attribute: "[x1,y1][x2,y2]". */
function parseAndroidBounds(value: string | undefined): Bounds {
  const match = value?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return { x: 0, y: 0, width: 0, height: 0 };
  const [x1, y1, x2, y2] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

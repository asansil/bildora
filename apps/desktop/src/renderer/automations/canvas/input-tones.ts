/**
 * The color of a block's input, which ends the connections coming into it: the accent while one
 * is chosen or pointed at, the text color when the run took one, and red for an Error connection.
 */
export type InputTone = 'accent' | 'taken' | 'error';

/** A connection as the canvas draws it. */
export interface TonedEdge {
  readonly id: string;
  readonly target: string;
  readonly className?: string;
  readonly selected?: boolean;
}

/** Classes that draw a connection in the accent. */
const ACCENT_CLASSES = ['edge--splice', 'edge--pending', 'edge--port-hover'];
/** A connection about to go away says nothing about the input it ends at. */
const REPLACED = 'edge--replaced';
const RANK: Readonly<Record<InputTone, number>> = { accent: 3, taken: 2, error: 1 };

function toneOf(edge: TonedEdge, hovered: string | undefined): InputTone | undefined {
  const classes = (edge.className ?? '').split(/\s+/);
  if (classes.includes(REPLACED)) return undefined;
  if (
    edge.selected === true ||
    edge.id === hovered ||
    classes.some((name) => ACCENT_CLASSES.includes(name))
  ) {
    return 'accent';
  }
  if (classes.includes('edge--taken')) return 'taken';
  if (classes.includes('edge--error')) return 'error';
  return undefined;
}

/** Each input's tone by block id; an input with several connections takes the strongest one. */
export function inputTones(
  edges: readonly TonedEdge[],
  hovered: string | undefined,
): ReadonlyMap<string, InputTone> {
  const tones = new Map<string, InputTone>();
  for (const edge of edges) {
    const tone = toneOf(edge, hovered);
    if (tone === undefined) continue;
    const known = tones.get(edge.target);
    if (known === undefined || RANK[tone] > RANK[known]) tones.set(edge.target, tone);
  }
  return tones;
}

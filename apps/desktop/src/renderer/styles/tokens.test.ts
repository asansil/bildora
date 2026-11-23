import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

type Scheme = 'light' | 'dark';
type Rgb = readonly [number, number, number];

function declarations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--bildora-[a-z0-9-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      found.set(name, value.trim());
    }
  }
  return found;
}

const tokens = declarations();

/** Reads a token in one theme, following `var()` to the token it names. */
function colorOf(name: string, scheme: Scheme): Rgb {
  const value = tokens.get(`--bildora-${name}`);
  if (value === undefined) {
    throw new Error(`No token ${name}`);
  }
  const alias = /^var\(--bildora-([a-z0-9-]+)\)$/.exec(value)?.[1];
  if (alias !== undefined) {
    return colorOf(alias, scheme);
  }
  const pair = /^light-dark\((oklch\([^)]*\)),\s*(oklch\([^)]*\))\)$/.exec(value);
  const color = scheme === 'light' ? pair?.[1] : pair?.[2];
  const channels =
    color === undefined ? undefined : /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(color);
  if (channels === undefined || channels === null) {
    throw new Error(`Token ${name} is not an opaque light-dark oklch color: ${value}`);
  }
  return oklchToLinearSrgb(Number(channels[1]), Number(channels[2]), Number(channels[3]));
}

function oklchToLinearSrgb(lightness: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminance([red, green, blue]: Rgb): number {
  const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
  return 0.2126 * clamp(red) + 0.7152 * clamp(green) + 0.0722 * clamp(blue);
}

function contrast(first: Rgb, second: Rgb): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

const SURFACES = [
  'surface-frame',
  'surface-panel',
  'surface-base',
  'surface-raised',
  'surface-hover',
  'surface-selected',
];
const TEXTS = [
  'text',
  'text-muted',
  'accent',
  'status-running',
  'status-completed',
  'status-failed',
  'status-cancelled',
  'status-warning',
];

describe('theme tokens', () => {
  it('uses only lowercase names with the shared prefix', () => {
    expect(tokens.size).toBeGreaterThan(0);
    for (const name of tokens.keys()) {
      expect(name).toMatch(/^--bildora-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  });

  describe.each<Scheme>(['light', 'dark'])('in the %s theme', (scheme) => {
    it.each(SURFACES.flatMap((surface) => TEXTS.map((text) => [text, surface] as const)))(
      '%s stays readable on %s',
      (text, surface) => {
        expect(contrast(colorOf(text, scheme), colorOf(surface, scheme))).toBeGreaterThanOrEqual(
          4.5,
        );
      },
    );

    it('keeps text readable on the main action', () => {
      for (const action of ['accent', 'accent-hover']) {
        expect(
          contrast(colorOf('on-accent', scheme), colorOf(action, scheme)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('keeps text readable on a dangerous action', () => {
      expect(
        contrast(colorOf('on-danger', scheme), colorOf('status-failed', scheme)),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['start', 'tool', 'condition', 'parallel', 'wait'])(
      'shows the %s family icon on its tint and on a block',
      (family) => {
        for (const surface of [`family-${family}-tint`, 'surface-raised']) {
          expect(
            contrast(colorOf(`family-${family}`, scheme), colorOf(surface, scheme)),
          ).toBeGreaterThanOrEqual(3);
        }
      },
    );

    it('makes the focus ring and control borders visible', () => {
      for (const surface of SURFACES) {
        expect(
          contrast(colorOf('focus-ring', scheme), colorOf(surface, scheme)),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(colorOf('border-strong', scheme), colorOf(surface, scheme)),
        ).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

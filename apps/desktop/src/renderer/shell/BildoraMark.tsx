import { useId } from 'react';

/** One tile of the ring: centre, rotation, fill stops, fill gradient line and highlight gradient line. */
interface Tile {
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly stops: readonly [string, string];
  readonly fill: readonly [number, number, number, number];
  readonly highlight: readonly [number, number, number, number];
}

// Taken from build/icon.svg, so the mark in the window matches the app icon.
const TILES: readonly Tile[] = [
  {
    x: 96.959,
    y: 24.474,
    rotate: 116.167,
    stops: ['#41b8a5', '#109580'],
    fill: [-29.985, 39.775, 29.985, -39.775],
    highlight: [-44.827, 22.025, 8.965, -4.405],
  },
  {
    x: 46.175,
    y: 88.701,
    rotate: 164.5,
    stops: ['#48c2d0', '#17a1b0'],
    fill: [9.779, 48.841, -9.779, -48.841],
    highlight: [-13.347, 48.129, 2.669, -9.626],
  },
  {
    x: -35.565,
    y: 93.462,
    rotate: 212.833,
    stops: ['#55ace9', '#2688cc'],
    fill: [42.987, 25.164, -42.987, -25.164],
    highlight: [27.081, 41.967, -5.416, -8.393],
  },
  {
    x: -93.462,
    y: 35.565,
    rotate: 261.167,
    stops: ['#6490eb', '#3768cf'],
    fill: [47.376, -15.383, -47.376, 15.383],
    highlight: [49.353, 7.67, -9.871, -1.534],
  },
  {
    x: -88.701,
    y: -46.175,
    rotate: 309.5,
    stops: ['#7e7ceb', '#5552cf'],
    fill: [20.004, -45.618, -20.004, 45.618],
    highlight: [38.539, -31.769, -7.708, 6.354],
  },
  {
    x: -24.474,
    y: -96.959,
    rotate: 357.833,
    stops: ['#a172e6', '#7c47ca'],
    fill: [-20.779, -45.27, 20.779, 45.27],
    highlight: [1.888, -49.91, -0.378, 9.982],
  },
];

const HALF = 49.946;
const RADIUS = 23.974;
const EDGE_HALF = 47.6;
const EDGE_RADIUS = 21.628;

interface BildoraMarkProps {
  /**
   * `small` drops the shadow and the light edge, which only blur below about 24 px;
   * `large` keeps the full detail of the app icon.
   */
  readonly size?: 'small' | 'large';
}

/** The app's mark: a ring of six tiles, as in the app icon. */
export function BildoraMark({ size = 'small' }: BildoraMarkProps) {
  // Each copy needs its own gradient ids; characters React puts in ids are not safe inside url().
  const prefix = `bm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const detailed = size === 'large';
  // Trimmed to the tiles' bounds, with a little room for the shadow when it is drawn.
  const viewBox = detailed ? '18.5 16 220 220' : '22.5 19 212 212';

  return (
    <svg className="bildora-mark" viewBox={viewBox} aria-hidden="true">
      <defs>
        {detailed ? (
          <filter id={`${prefix}s`} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow
              dx="0"
              dy="2.933"
              stdDeviation="4.399"
              floodColor="#0b1a2a"
              floodOpacity="0.28"
            />
          </filter>
        ) : null}
        {TILES.map((tile, index) => (
          <linearGradient
            key={`g${String(index)}`}
            id={`${prefix}g${String(index)}`}
            gradientUnits="userSpaceOnUse"
            x1={tile.fill[0]}
            y1={tile.fill[1]}
            x2={tile.fill[2]}
            y2={tile.fill[3]}
          >
            <stop offset="0" stopColor={tile.stops[0]} />
            <stop offset="1" stopColor={tile.stops[1]} />
          </linearGradient>
        ))}
        {detailed
          ? TILES.map((tile, index) => (
              <linearGradient
                key={`h${String(index)}`}
                id={`${prefix}h${String(index)}`}
                gradientUnits="userSpaceOnUse"
                x1={tile.highlight[0]}
                y1={tile.highlight[1]}
                x2={tile.highlight[2]}
                y2={tile.highlight[3]}
              >
                <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
            ))
          : null}
      </defs>
      <g transform="translate(126.363 123.311) scale(0.682)">
        {TILES.map((tile, index) => (
          <g
            key={index}
            transform={`translate(${String(tile.x)} ${String(tile.y)}) rotate(${String(tile.rotate)})`}
            filter={detailed ? `url(#${prefix}s)` : undefined}
          >
            <rect
              x={-HALF}
              y={-HALF}
              width={HALF * 2}
              height={HALF * 2}
              rx={RADIUS}
              fill={`url(#${prefix}g${String(index)})`}
            />
            {detailed ? (
              <rect
                x={-EDGE_HALF}
                y={-EDGE_HALF}
                width={EDGE_HALF * 2}
                height={EDGE_HALF * 2}
                rx={EDGE_RADIUS}
                fill="none"
                stroke={`url(#${prefix}h${String(index)})`}
                strokeWidth="4.692"
              />
            ) : null}
          </g>
        ))}
      </g>
    </svg>
  );
}

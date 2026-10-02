import { CLASS_COUNT, Class } from './voxels';

/**
 * How a voxel world is coloured, shaded and outlined. A palette never changes which cubes or faces
 * exist: the mesh builder emits the same quads for every palette (it only reads `outline.mode`,
 * `ao.strength` and `lamp.pool` to decide which per-vertex extras to fill in). Everything else is a
 * uniform in the one world shader, so the look is free at runtime. Colours are sRGB hex strings and
 * the shader writes them straight to the screen, with no tone mapping.
 *
 * This module is worker-safe: no DOM, no WebGL.
 */

export type Rgb = readonly [number, number, number];

/** Parses `#rgb` or `#rrggbb` into sRGB components in 0..1. */
export function rgb(hex: string): Rgb {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) throw new Error(`bad colour "${hex}"`);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export type ClassKey = Exclude<keyof typeof Class, 'AIR'>;

export interface ClassLook {
  /** colour of faces that look up */
  top: string;
  /** colour of the walls; defaults to `top` */
  side?: string;
  /** random per-cube brightness variation, 0..1 of the colour */
  jitter?: number;
  /** false: this class never gets outline lines (roads read as one ribbon) */
  outline?: boolean;
}

/** 'cube': every cube; 'outline': silhouettes, creases, steps and class borders only. */
export type OutlineMode = 'none' | 'cube' | 'outline';

export interface Palette {
  id: string;
  name: string;
  /** one line for the lab and the write-up */
  blurb: string;
  classes: Readonly<Record<ClassKey, ClassLook>>;
  /** Colour multipliers per face direction. Light comes from the upper left of the default view: south is lit, east is in shade. */
  faces: { top: string; south: string; east: string; north: string; west: string };
  outline: {
    mode: OutlineMode;
    color: string;
    /** 0: always `color`; 1: the face's own colour darkened (a tinted pencil line) */
    tint: number;
    /** half-width in CSS px */
    width: number;
    opacity: number;
  };
  /** Corner ambient occlusion from neighbour occupancy: the classic voxel trick. strength 0 turns it off. */
  ao: { strength: number; gamma: number; tint: string };
  background: {
    top: string;
    bottom: string;
    /** 0..1 darkening of the corners */
    vignette: number;
    /** screen-space paper/film grain in the sky, 0..1 */
    grain: number;
    /** density of tiny stars in the upper sky, 0 for none */
    stars: number;
  };
  /** Depth fade towards `color` on the far side of the view's focus; start/end are fractions of the world size. */
  fog?: { color: string; start: number; end: number; amount: number };
  /** screen-space grain over the cubes themselves (paper), 0..1 */
  grain: number;
  /** Snap every colour to a fixed ramp (dark to light) on chunky pixels; implies no antialiasing. */
  quantize?: { colors: readonly string[]; cssPixel: number };
  /** Lit windows speckled over building walls, hashed per cube. */
  windows?: { color: string; alt: string; density: number };
  /** The tip of every pole: tinted, optionally emissive with a halo and a pool of light on its surroundings. */
  lamp?: {
    color: string;
    /** 0..1: how much the tip cube takes the lamp colour */
    tip: number;
    /** brightness of the tip after shading (1 = exactly `color`) */
    glow: number;
    /** halo sprite diameter in metres; 0 or absent: none */
    halo?: number;
    /** light pool radius in metres; 0 or absent: none */
    pool?: number;
    poolStrength?: number;
  };
  /** Walls darken towards the ground like a wash: strength 0..1 at y = 0, falling off with e-fold `height` (in world units). */
  wallFade?: { strength: number; height: number };
  /** Brightness stripes on water tops, 0..1. */
  ripple: number;
}

const CLASS_KEYS: readonly ClassKey[] = [
  'GROUND', 'ROAD', 'SIDEWALK', 'BUILDING', 'ROOF', 'VEGETATION', 'POLE', 'WATER', 'RAIL', 'BRIDGE', 'FURNITURE', 'FENCE',
];

/** The look of class id `c` (unknown ids render as furniture, like the mesh builder counts them). */
export function classLook(palette: Palette, c: number): ClassLook {
  const key = c > 0 && c < CLASS_COUNT ? CLASS_KEYS[c - 1] : 'FURNITURE';
  return palette.classes[key];
}

// ---------------------------------------------------------------------------------------------
// 1. Refined mono: the brand black and white, calmed down. White sky, soft greys, voxel AO and
//    a hairline only where the surface creases or ends. Nothing dithers.
const mono: Palette = {
  id: 'mono',
  name: 'Refined mono',
  blurb: 'White sky, soft greys, corner AO, grey hairlines on silhouettes and creases.',
  classes: {
    GROUND: { top: '#dedede', jitter: 0.012 },
    ROAD: { top: '#939393', outline: false },
    SIDEWALK: { top: '#f1f1f1' },
    BUILDING: { top: '#efefef' },
    ROOF: { top: '#fafafa' },
    VEGETATION: { top: '#8e8e8e', side: '#7c7c7c', jitter: 0.1, outline: false },
    POLE: { top: '#141414', outline: false },
    WATER: { top: '#c3c3c3', side: '#b4b4b4' },
    RAIL: { top: '#7c7c7c' },
    BRIDGE: { top: '#c9c9c9' },
    FURNITURE: { top: '#6e6e6e' },
    FENCE: { top: '#a4a4a4' },
  },
  faces: { top: '#ffffff', south: '#cfcfcf', east: '#9a9a9a', north: '#b4b4b4', west: '#bbbbbb' },
  outline: { mode: 'outline', color: '#111111', tint: 0, width: 0.5, opacity: 0.7 },
  ao: { strength: 0.65, gamma: 1.0, tint: '#222222' },
  background: { top: '#ffffff', bottom: '#f1f1f1', vignette: 0, grain: 0, stars: 0 },
  fog: { color: '#f6f6f6', start: 0.1, end: 0.8, amount: 0.5 },
  grain: 0,
  wallFade: { strength: 0.22, height: 14 },
  ripple: 0.12,
};

// ---------------------------------------------------------------------------------------------
// 2. Game Boy DMG: the four olive greens, snapped to chunky pixels, hard one-pixel outlines.
const DMG = ['#0f380f', '#306230', '#8bac0f', '#cadc9f'] as const;
const gameboy: Palette = {
  id: 'gameboy',
  name: 'Game Boy DMG',
  blurb: 'Four olive greens on 2 px pixels; each class picks a ramp step and its walls step down with the light.',
  classes: {
    GROUND: { top: '#9a9a9a' },
    ROAD: { top: '#5c5c5c', outline: false },
    SIDEWALK: { top: '#ffffff' },
    BUILDING: { top: '#e0e0e0' },
    ROOF: { top: '#ffffff' },
    VEGETATION: { top: '#555555', side: '#505050', jitter: 0.22, outline: false },
    POLE: { top: '#000000', outline: false },
    WATER: { top: '#a8a8a8', side: '#8c8c8c' },
    RAIL: { top: '#555555' },
    BRIDGE: { top: '#c0c0c0' },
    FURNITURE: { top: '#666666' },
    FENCE: { top: '#808080' },
  },
  faces: { top: '#ffffff', south: '#b6b6b6', east: '#757575', north: '#8c8c8c', west: '#999999' },
  outline: { mode: 'outline', color: '#000000', tint: 0, width: 1.1, opacity: 1 },
  ao: { strength: 0.25, gamma: 1.6, tint: '#000000' },
  background: { top: DMG[3], bottom: DMG[3], vignette: 0, grain: 0, stars: 0 },
  grain: 0,
  quantize: { colors: DMG, cssPixel: 2 },
  ripple: 0.45,
};

// ---------------------------------------------------------------------------------------------
// 3. Washi & sumi: a warm paper ground, ink outlines and trees, indigo for water and roofs,
//    vermilion lamp tips as the single accent (like a hanko seal), grain on everything.
const washi: Palette = {
  id: 'washi',
  name: 'Washi & sumi',
  blurb: 'Paper ground with grain, sumi ink lines, indigo water and roofs, vermilion lamp tips.',
  classes: {
    GROUND: { top: '#e4d8bd', jitter: 0.02 },
    ROAD: { top: '#b0a591', outline: false },
    SIDEWALK: { top: '#f2e9d3' },
    BUILDING: { top: '#f5eedb' },
    ROOF: { top: '#a9b4c6' },
    VEGETATION: { top: '#5b6350', side: '#474d3e', jitter: 0.2, outline: false },
    POLE: { top: '#1d1a17', outline: false },
    WATER: { top: '#3f5d86', side: '#32496b' },
    RAIL: { top: '#6c6354' },
    BRIDGE: { top: '#c4553c' },
    FURNITURE: { top: '#8a7f6c' },
    FENCE: { top: '#8f8570' },
  },
  faces: { top: '#ffffff', south: '#dcd0b8', east: '#b5a68c', north: '#c5b89f', west: '#cabda4' },
  outline: { mode: 'outline', color: '#241e1a', tint: 0, width: 0.65, opacity: 0.88 },
  ao: { strength: 0.5, gamma: 1.1, tint: '#6a5a4e' },
  background: { top: '#f1e9d6', bottom: '#e8dcc2', vignette: 0.22, grain: 0.09, stars: 0 },
  fog: { color: '#eadfc7', start: 0.15, end: 0.9, amount: 0.45 },
  grain: 0.08,
  wallFade: { strength: 0.3, height: 10 },
  lamp: { color: '#c9442b', tip: 1, glow: 1 },
  ripple: 0.22,
};

// ---------------------------------------------------------------------------------------------
// 4. Tokyo dusk: blue-black sky and haze, dark towers with a few lit windows, sodium-tinted
//    roads, and warm lamp tips with a halo and a pool of light on the street.
const night: Palette = {
  id: 'night',
  name: 'Tokyo night',
  blurb: 'Blue-black haze, lit window speckle, sodium roads, glowing lamp tips with halos and light pools.',
  classes: {
    GROUND: { top: '#1d2038', jitter: 0.03 },
    ROAD: { top: '#2f2b3a', outline: false },
    SIDEWALK: { top: '#3b3e5c' },
    BUILDING: { top: '#323d6a', jitter: 0.06 },
    ROOF: { top: '#222a4c' },
    VEGETATION: { top: '#16343a', side: '#11282d', jitter: 0.14, outline: false },
    POLE: { top: '#090a14', outline: false },
    WATER: { top: '#0d2347', side: '#091a37' },
    RAIL: { top: '#4a4660' },
    BRIDGE: { top: '#3a3a58' },
    FURNITURE: { top: '#4a4d70' },
    FENCE: { top: '#2f3250' },
  },
  faces: { top: '#ffffff', south: '#b9c0e0', east: '#7480ad', north: '#8a93bd', west: '#8089b4' },
  outline: { mode: 'outline', color: '#8aa2ff', tint: 0, width: 0.5, opacity: 0.26 },
  ao: { strength: 0.7, gamma: 1.0, tint: '#05060d' },
  background: { top: '#03040c', bottom: '#1a1740', vignette: 0.35, grain: 0.03, stars: 0.0016 },
  fog: { color: '#141738', start: 0.08, end: 0.75, amount: 0.8 },
  grain: 0.02,
  windows: { color: '#ffd68a', alt: '#bfe0ff', density: 0.17 },
  lamp: { color: '#ffb85a', tip: 1, glow: 1.15, halo: 4.5, pool: 8, poolStrength: 1.4 },
  wallFade: { strength: 0.35, height: 8 },
  ripple: 0.4,
};

// ---------------------------------------------------------------------------------------------
// 5. Foam-core model: white card buildings on a pale board, sage trees, light warm roads, very
//    soft AO and pencil edges; the coral pins (poles) are the one accent.
const foam: Palette = {
  id: 'foam',
  name: 'Foam-core model',
  blurb: 'White foam-core blocks on a pale board, sage trees, warm grey roads, soft AO, coral lamp pins.',
  classes: {
    GROUND: { top: '#d8d1c0', jitter: 0.012 },
    ROAD: { top: '#bdb5a2', outline: false },
    SIDEWALK: { top: '#efece3' },
    BUILDING: { top: '#fffdf9' },
    ROOF: { top: '#ffffff' },
    VEGETATION: { top: '#adc493', side: '#98b17e', jitter: 0.07, outline: false },
    POLE: { top: '#7b7467', outline: false },
    WATER: { top: '#c5d6dc', side: '#b3c7cf' },
    RAIL: { top: '#a39d8e' },
    BRIDGE: { top: '#ece7da' },
    FURNITURE: { top: '#d6cfbf' },
    FENCE: { top: '#cdc6b6' },
  },
  faces: { top: '#ffffff', south: '#ebe7de', east: '#d3cdc0', north: '#ddd8cc', west: '#e0dbd0' },
  outline: { mode: 'outline', color: '#8c8576', tint: 0.5, width: 0.6, opacity: 0.7 },
  ao: { strength: 0.5, gamma: 1.5, tint: '#7a7366' },
  background: { top: '#f3eee4', bottom: '#e5ded0', vignette: 0.08, grain: 0, stars: 0 },
  fog: { color: '#eee9de', start: 0.15, end: 0.9, amount: 0.4 },
  grain: 0,
  lamp: { color: '#e2705a', tip: 1, glow: 1 },
  wallFade: { strength: 0.14, height: 12 },
  ripple: 0.1,
};

/**
 * The palette for cubes of `metersPerCube` metres. Lamp halos and light pools are authored in
 * metres, so they shrink (in cubes) as the cubes grow; everything else is per-cube already.
 */
export function forCubeSize(palette: Palette, metersPerCube: number): Palette {
  const lamp = palette.lamp;
  if (!lamp || metersPerCube === 1) return palette;
  return {
    ...palette,
    lamp: {
      ...lamp,
      halo: lamp.halo ? Math.max(1.5, lamp.halo / metersPerCube) : lamp.halo,
      pool: lamp.pool ? Math.max(2, lamp.pool / metersPerCube) : lamp.pool,
    },
  };
}

export const PALETTES: readonly Palette[] = [mono, gameboy, washi, night, foam];

export const DEFAULT_PALETTE: Palette = foam;

export function paletteById(id: string): Palette {
  const found = PALETTES.find((p) => p.id === id);
  if (!found) throw new Error(`unknown palette "${id}" (have ${PALETTES.map((p) => p.id).join(', ')})`);
  return found;
}

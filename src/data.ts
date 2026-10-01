/** Typed loaders for the JSON the pipeline writes to public/. Every file is validated where it crosses in. */

export interface River {
  id: string;
  rank: number;
  name: string;
  length_km: number;
  /** west, south, east, north in degrees (east may exceed 180 for antimeridian rivers) */
  bbox: [number, number, number, number];
  page: number;
  /** atlas rect u0, v0, u1, v1 with v = 0 at the top row */
  uv: [number, number, number, number];
}

export interface Manifest {
  pageSize: number;
  pages: number;
  rivers: River[];
}

export interface Creature {
  id: string;
  common: string;
  riverId: string;
  /** [lon, lat] of a spot on the river, used as camera target and note anchor */
  focus: [number, number];
  /** pixelated black-and-white sprite, relative to the site root */
  sprite: string;
}

export interface AudioEntry {
  file: string;
  loop: boolean;
}

export interface RiverName {
  lang: string;
  name: string;
}

export interface CreatureData {
  creatures: Creature[];
  audio: ReadonlyMap<string, AudioEntry>;
  names: ReadonlyMap<string, RiverName[]>;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`${what}: expected a non-empty string`);
  return v;
}

function pair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
    throw new Error(`${what}: expected [number, number]`);
  }
  return [v[0], v[1]];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function parseCreature(v: unknown): Creature {
  if (!isDict(v)) throw new Error('creatures.json: entry is not an object');
  const id = str(v.id, 'creature.id');
  return {
    id,
    common: str(v.common, `${id}.common`),
    riverId: str(v.riverId, `${id}.riverId`),
    focus: pair(v.focus, `${id}.focus`),
    sprite: str(v.sprite, `${id}.sprite`),
  };
}

function parseAudio(v: unknown): Map<string, AudioEntry> {
  if (!isDict(v)) throw new Error('audio.json: expected an object');
  return new Map(
    Object.entries(v).map(([id, e]) => {
      if (!isDict(e)) throw new Error(`audio.json ${id}: expected an object`);
      return [id, { file: str(e.file, `${id}.file`), loop: e.loop === true }];
    }),
  );
}

function parseNames(v: unknown): Map<string, RiverName[]> {
  if (!isDict(v)) throw new Error('river-names.json: expected an object');
  return new Map(
    Object.entries(v).map(([riverId, list]) => {
      if (!Array.isArray(list)) throw new Error(`river-names.json ${riverId}: expected an array`);
      const seen = new Set<string>();
      const names: RiverName[] = [];
      for (const n of list) {
        if (!isDict(n)) throw new Error(`river-names.json ${riverId}: entry is not an object`);
        const name = str(n.name, `${riverId}.name`).normalize('NFC').trim();
        // Same name in two languages (e.g. pt/es "Río Negro" written alike) is shown once.
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        names.push({ lang: str(n.lang, `${riverId}.lang`), name });
      }
      return [riverId, names];
    }),
  );
}

export async function loadManifest(): Promise<Manifest> {
  const v = await getJson('/rivers.json');
  // Written by pipeline/rasterize.py; shape is trusted after the object check.
  if (!isDict(v) || !Array.isArray(v.rivers) || typeof v.pages !== 'number' || typeof v.pageSize !== 'number') {
    throw new Error('rivers.json: unexpected shape');
  }
  return { pageSize: v.pageSize, pages: v.pages, rivers: v.rivers.map(parseRiver) };
}

function parseRiver(v: unknown): River {
  if (!isDict(v)) throw new Error('rivers.json: river is not an object');
  const quad = (x: unknown, what: string): [number, number, number, number] => {
    if (!Array.isArray(x) || x.length !== 4 || x.some((n) => typeof n !== 'number')) {
      throw new Error(`rivers.json ${what}: expected 4 numbers`);
    }
    return [x[0], x[1], x[2], x[3]];
  };
  const num = (x: unknown, what: string): number => {
    if (typeof x !== 'number') throw new Error(`rivers.json ${what}: expected a number`);
    return x;
  };
  const id = str(v.id, 'river.id');
  return {
    id,
    rank: num(v.rank, `${id}.rank`),
    name: str(v.name, `${id}.name`),
    length_km: num(v.length_km, `${id}.length_km`),
    bbox: quad(v.bbox, `${id}.bbox`),
    page: num(v.page, `${id}.page`),
    uv: quad(v.uv, `${id}.uv`),
  };
}

export async function loadCreatureData(): Promise<CreatureData> {
  const [creatures, audio, names] = await Promise.all([
    getJson('/creatures/creatures.json'),
    getJson('/audio/audio.json'),
    getJson('/creatures/river-names.json'),
  ]);
  if (!Array.isArray(creatures)) throw new Error('creatures.json: expected an array');
  return { creatures: creatures.map(parseCreature), audio: parseAudio(audio), names: parseNames(names) };
}

import type { VoxelGrid } from '../cubeworld/voxels';

/** The `<id>.json` side of a voxel file (see research/cubeworld-japan.md). */
export interface VoxelMeta {
  id: string;
  source: string;
  license: string;
  attribution: string;
  method: string;
  metersPerCube: number;
  dims: [number, number, number];
  origin: { lat: number; lon: number; epsg: number; x: number; y: number; groundZ: number };
  classCounts: Record<string, number>;
  notes: string | string[];
}

export interface LoadedVoxels {
  meta: VoxelMeta;
  grid: VoxelGrid;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseMeta(raw: unknown, id: string): VoxelMeta {
  if (!isRecord(raw)) throw new Error(`${id}.json is not an object`);
  const { dims } = raw;
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error(`${id}.json: dims must be three positive integers`);
  }
  const [nx, ny, nz] = dims as [number, number, number];
  if (nx > 200 || ny > 100 || nz > 200) throw new Error(`${id}.json: dims ${nx}x${ny}x${nz} exceed 200x100x200`);
  const text = (key: string): string => (typeof raw[key] === 'string' ? raw[key] : '');
  const origin = isRecord(raw.origin) ? raw.origin : {};
  const num = (key: string): number => (typeof origin[key] === 'number' ? origin[key] : 0);
  const notes = raw.notes;
  return {
    id: text('id') || id,
    source: text('source'),
    license: text('license'),
    attribution: text('attribution'),
    method: text('method'),
    metersPerCube: typeof raw.metersPerCube === 'number' ? raw.metersPerCube : 1,
    dims: [nx, ny, nz],
    origin: { lat: num('lat'), lon: num('lon'), epsg: num('epsg'), x: num('x'), y: num('y'), groundZ: num('groundZ') },
    classCounts: isRecord(raw.classCounts)
      ? Object.fromEntries(Object.entries(raw.classCounts).filter((e): e is [string, number] => typeof e[1] === 'number'))
      : {},
    notes: typeof notes === 'string' || (Array.isArray(notes) && notes.every((n) => typeof n === 'string')) ? (notes as string | string[]) : '',
  };
}

/** Fetches `/lab/voxels/<id>.json` and `.bin` and checks that they agree. */
export async function loadVoxels(id: string): Promise<LoadedVoxels> {
  const [metaRes, binRes] = await Promise.all([fetch(`/lab/voxels/${id}.json`), fetch(`/lab/voxels/${id}.bin`)]);
  if (!metaRes.ok) throw new Error(`/lab/voxels/${id}.json: ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`/lab/voxels/${id}.bin: ${binRes.status}`);
  const meta = parseMeta(await metaRes.json(), id);
  const cells = new Uint8Array(await binRes.arrayBuffer());
  const [nx, ny, nz] = meta.dims;
  if (cells.length !== nx * ny * nz) {
    throw new Error(`${id}.bin has ${cells.length} bytes, dims ${nx}x${ny}x${nz} need ${nx * ny * nz}`);
  }
  return { meta, grid: { cells, nx, ny, nz } };
}

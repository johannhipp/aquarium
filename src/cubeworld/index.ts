import { createVoxelScene, type SceneStats } from './scene';
import { generateTerrain } from './terrain';

const SEED = 64;

export type CubeworldStats = SceneStats;

export interface Cubeworld {
  /** Show the scene and run the render loop (it only draws when something changed). */
  start(): void;
  /** Stop the loop and the key listeners; the camera stays where it was. */
  stop(): void;
  /** Free the GPU resources and remove the canvas. */
  dispose(): void;
  stats(): CubeworldStats;
}

/** The prototype landscape: a 50 x 50 voxel world, up to 100 cubes high. */
export function createCubeworld(container: HTMLElement): Cubeworld {
  return createVoxelScene(container, generateTerrain(SEED), { eyeBase: 14, eyeFollow: 0.5 });
}

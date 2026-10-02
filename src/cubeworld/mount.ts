import type { Player } from '../audio';
import type { Globe } from '../globe';
import { createGuide, type Guide, type GuideStage } from '../guide';
import type { Note } from '../note';
import type { Place } from '../places';
import { onCreatureView } from '../session';
import { createTransition } from '../transition';
import { createUnlock } from '../unlock';
import { createWallet } from '../wallet';

export interface CubeworldFeatures {
  /** Call once the rest of the top-right cluster is on screen: an already-unlocked visitor sees the wallet now, silently. */
  reveal(): void;
  /** Off while a modal dialog is up, so drag and wheel never reach the map behind it. */
  setInteractive(on: boolean): void;
}

/**
 * Everything around cubeworld in one call: counting distinct creature views, the unlock chime, the
 * wallet with its dropdown, the iris transition between the globe and the map, and the place index
 * that lives on the map. The map itself (three.js scene, workers, about 20 MB of Minato-ku chunks
 * read with range requests) is only fetched when the wallet opens or the cube is chosen.
 */
export function mountCubeworldFeatures(opts: {
  /** The top-right icon cluster; the wallet is appended after the ?, so it sits at the far right. */
  corner: HTMLElement;
  globe: Pick<Globe, 'setActive'>;
  player: Pick<Player, 'play' | 'preload' | 'setTitle'>;
  note: Note;
  places: readonly Place[];
  /** The globe's own index, put to sleep while the map is on screen. */
  creatures: Pick<Guide, 'sleep' | 'wake'>;
}): CubeworldFeatures {
  const cameraListeners: Array<() => void> = [];
  const stage: GuideStage<Place> = {
    flyTo: (place, instant) => (transition.cube ? transition.cube.flyTo(place, { instant }) : Promise.resolve(false)),
    project: (place, out) => transition.cube?.project(place, out),
    onCameraMove: (cb) => cameraListeners.push(cb),
  };
  const guide = createGuide({
    host: document.body,
    kind: 'places',
    label: 'Places',
    items: opts.places,
    stage,
    player: opts.player,
    note: opts.note,
    awake: false,
  });

  const transition = createTransition({
    globe: opts.globe,
    focus: () => opts.places,
    onCube: (cube) => cube.onCameraMove(() => cameraListeners.forEach((cb) => cb())),
    onWorld: (world) => {
      wallet.setWorld(world);
      if (world === 'cube') {
        opts.creatures.sleep();
        guide.wake();
        void guide.reveal();
      } else {
        guide.sleep();
        opts.creatures.wake();
      }
    },
  });
  const wallet = createWallet(opts.corner, {
    onGlobe: (from) => void transition.toGlobe(from),
    onCube: (from) => void transition.toCube(from),
    onOpen: () => transition.preload(),
  });
  const unlock = createUnlock({ onUnlock: () => wallet.reveal() });
  wallet.setWorld('globe');
  onCreatureView((creatureId) => unlock.recordView(creatureId));

  return {
    reveal() {
      if (unlock.unlocked) wallet.reveal();
    },
    setInteractive(on) {
      transition.cube?.setInteractive(on);
    },
  };
}

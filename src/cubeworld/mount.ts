import type { Player } from '../audio';
import type { Globe } from '../globe';
import { onCreatureView } from '../session';
import { createTransition } from '../transition';
import { createUnlock } from '../unlock';
import { createWallet } from '../wallet';

export interface CubeworldFeatures {
  /** Call once the rest of the top-right cluster is on screen: an already-unlocked visitor sees the wallet now, silently. */
  reveal(): void;
}

/**
 * Everything around cubeworld in one call: counting distinct creature views, the unlock chime, the
 * wallet with its dropdown, and the iris transition between the globe and the landscape. The
 * landscape itself (three.js scene, ~50 KB of shader and terrain code) is only fetched when the
 * wallet opens or the cube is chosen.
 */
export function mountCubeworldFeatures(opts: {
  /** The top-right icon cluster; the wallet is appended after the ?, so it sits at the far right. */
  corner: HTMLElement;
  globe: Pick<Globe, 'setActive'>;
  player: Pick<Player, 'suspend' | 'resume'>;
}): CubeworldFeatures {
  const transition = createTransition({
    globe: opts.globe,
    player: opts.player,
    onWorld: (world) => wallet.setWorld(world),
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
  };
}

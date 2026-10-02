import '@fontsource/inter/400.css';
import './style.css';
import { createAbout } from './about';
import { audioAllowed, createPlayer } from './audio';
import { mountCubeworldFeatures, type CubeworldFeatures } from './cubeworld/mount';
import { loadCreatureData, loadManifest, type Creature } from './data';
import { runSoundGate } from './gate';
import { createGlobe, type Globe } from './globe';
import { createGuide, type GuideItem } from './guide';
import { createNote } from './note';
import { loadPlaces } from './places';
import { registerOffline } from './pwa';
import { emitCreatureView } from './session';

declare global {
  interface Window {
    /** Dev servers only: the globe, for alignment measurements. */
    __globe?: Globe;
  }
}

async function main(): Promise<void> {
  const [manifest, data] = await Promise.all([loadManifest(), loadCreatureData()]);
  const [globe, places] = await Promise.all([
    createGlobe(manifest),
    // The map is optional: if its files are missing the globe still works, only the map has no index.
    loadPlaces(data.audio).catch((e: unknown) => {
      console.error('Could not load the places', e);
      return [];
    }),
  ]);

  if (import.meta.env.DEV) window.__globe = globe;

  const audioHost = document.createElement('div');
  audioHost.hidden = true;
  document.body.appendChild(audioHost);
  const player = createPlayer(data.audio, audioHost);
  const note = createNote(document.body);

  // A river's native name is the OS media title and the note; the app draws no other text.
  const creatures: Array<Creature & GuideItem> = data.creatures.map((c) => {
    const names = data.names.get(c.riverId) ?? [];
    return { ...c, label: c.common, audioId: c.id, names, title: names[0]?.name ?? null };
  });
  const creatureGuide = createGuide({
    host: document.body,
    kind: 'creatures',
    label: 'Creatures',
    items: creatures,
    stage: {
      flyTo: (c, instant) => globe.flyTo(c.focus[0], c.focus[1], { instant }),
      project: (c, out) => globe.project(c.focus[0], c.focus[1], out),
      onCameraMove: (cb) => globe.onCameraMove(cb),
    },
    player,
    note,
    onPick: (c) => emitCreatureView(c.id),
  });

  // Whatever can open on top of the worlds takes their drag and wheel while it is up.
  let cubeworld: CubeworldFeatures | null = null;
  const setInteractive = (on: boolean): void => {
    globe.setInteractive(on);
    cubeworld?.setInteractive(on);
  };

  // The speaker gate: greets when sound works, blocks the page with a sad face when it does not.
  let gateBusy = false;
  async function soundGate(allowed: boolean): Promise<void> {
    gateBusy = true;
    try {
      await runSoundGate({
        allowed,
        unlock: () => player.unlock(),
        onModal: (open) => setInteractive(!open),
      });
    } finally {
      gateBusy = false;
    }
  }
  // Sound turned off at any time brings the blocking gate back; the current track resumes after it.
  player.onLost(() => {
    if (gateBusy) return;
    player.suspend();
    void soundGate(false).then(() => player.resume());
  });

  await soundGate(await audioAllowed());
  await player.resume(); // clears any loss signalled while the greeting was up
  // Top-right cluster: the ? first, further icons are appended after it (so they sit to its right).
  const corner = document.createElement('div');
  corner.className = 'corner';
  document.body.appendChild(corner);
  const about = createAbout(corner, (open) => setInteractive(!open));
  cubeworld = mountCubeworldFeatures({ corner, globe, player, note, places, creatures: creatureGuide });
  await creatureGuide.reveal();
  about.reveal();
  cubeworld.reveal();
}

registerOffline();
void main();

import '@fontsource/inter/400.css';
import './style.css';
import { createAbout } from './about';
import { audioAllowed, createPlayer } from './audio';
import { loadCreatureData, loadManifest, type Creature } from './data';
import { mountCubeworldFeatures } from './cubeworld/mount';
import { createDex } from './dex';
import { runSoundGate } from './gate';
import { createGlobe, type ScreenPoint } from './globe';
import { createNote } from './note';
import { emitCreatureView } from './session';

async function main(): Promise<void> {
  const [manifest, data] = await Promise.all([loadManifest(), loadCreatureData()]);
  const globe = await createGlobe(manifest);

  const audioHost = document.createElement('div');
  audioHost.hidden = true;
  document.body.appendChild(audioHost);
  const player = createPlayer(data.audio, audioHost);
  const note = createNote(document.body);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let selected: Creature | null = null;
  let anchor: Creature['focus'] | null = null;
  /** Bumped on every pick/deselect so a superseded flight never shows its note. */
  let run = 0;
  const screen: ScreenPoint = { x: 0, y: 0, facing: false };

  function placeNote(): void {
    if (!anchor) return;
    globe.project(anchor[0], anchor[1], screen);
    note.place(screen);
  }
  globe.onCameraMove(placeNote);

  function deselect(): void {
    selected = null;
    player.setTitle(null);
    run++;
    dex.select(null);
    note.hide();
    void player.play(null);
  }

  async function pick(creature: Creature): Promise<void> {
    if (selected?.id === creature.id) {
      deselect();
      return;
    }
    selected = creature;
    emitCreatureView(creature.id);
    const mine = ++run;
    dex.select(creature.id);
    note.hide();
    // Only the OS media controls see this; it is a native river name, never drawn by the app.
    player.setTitle(data.names.get(creature.riverId)?.[0]?.name ?? null);
    void player.play(creature.id);
    await globe.flyTo(creature.focus[0], creature.focus[1], { instant: reducedMotion.matches });
    // Arrived, or the user grabbed the globe: either way the note names the river.
    const names = data.names.get(creature.riverId);
    if (mine !== run || !names) return;
    anchor = creature.focus;
    placeNote();
    await note.show(names.slice(0, 3));
  }

  const dex = createDex(document.body, data.creatures, {
    onPick: (c) => void pick(c),
    onHover: (c) => player.preload(c.id),
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected && !document.querySelector('dialog[open]')) deselect();
  });

  // The speaker gate: greets when sound works, blocks the page with a sad face when it does not.
  let gateBusy = false;
  async function soundGate(allowed: boolean): Promise<void> {
    gateBusy = true;
    try {
      await runSoundGate({
        allowed,
        unlock: () => player.unlock(),
        onModal: (open) => globe.setInteractive(!open),
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
  const about = createAbout(corner, (open) => globe.setInteractive(!open));
  const cubeworld = mountCubeworldFeatures({ corner, globe, player });
  await dex.reveal();
  about.reveal();
  cubeworld.reveal();
}

void main();

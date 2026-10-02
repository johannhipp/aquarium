import type { Player } from './audio';
import type { LocalName } from './data';
import { createDex, type DexItem } from './dex';
import type { ScreenPoint } from './globe';
import type { Note } from './note';

export interface GuideItem extends DexItem {
  /** key of the loop in audio.json */
  audioId: string;
  /** native names for the note, most important first; none means no note */
  names: readonly LocalName[];
  /** shown by the OS media controls only, never by the app */
  title: string | null;
}

/** What a world offers its guide: a camera that can fly to an item and tell where it is on screen. */
export interface GuideStage<T> {
  /** Fly to the item; resolves true on arrival, false if the visitor grabbed the camera first. */
  flyTo(item: T, instant: boolean): Promise<boolean>;
  project(item: T, out: ScreenPoint): void;
  /** Called after every frame in which the camera may have moved. */
  onCameraMove(cb: () => void): void;
}

export interface Guide {
  /** Reveal the index once every sprite is decoded, with a short stagger. */
  reveal(): Promise<void>;
  /** The world leaves the screen: silence and hide the note, but keep the selection. */
  sleep(): void;
  /** The world is back: the selected item's sound and name return (or its flight resumes). */
  wake(): void;
}

const MAX_NAMES = 3;

/**
 * The index of one world, its camera, its sound and its note, in one place: click an item and the
 * track crossfades in while the camera flies there and, once it has, the name appears beside it;
 * click it again or press Esc and everything goes quiet. The river globe and the city map each get
 * one, sharing the player (so the sound gate and sound-loss rules are the same) and the note.
 */
export function createGuide<T extends GuideItem>(opts: {
  host: HTMLElement;
  /** CSS hook and accessible name of the index */
  kind: string;
  label: string;
  items: readonly T[];
  stage: GuideStage<T>;
  player: Pick<Player, 'play' | 'preload' | 'setTitle'>;
  note: Note;
  /** The world on screen when the page loads (default true). */
  awake?: boolean;
  /** Called when an item is picked (not when it is deselected). */
  onPick?: (item: T) => void;
}): Guide {
  const { stage, player, note } = opts;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let awake = opts.awake ?? true;
  let selected: T | null = null;
  let arrived = false;
  /** Bumped on every pick, deselect and sleep so a superseded flight never shows its note. */
  let run = 0;
  const screen: ScreenPoint = { x: 0, y: 0, facing: false };

  function placeNote(): void {
    if (!awake || !selected || !arrived) return;
    stage.project(selected, screen);
    note.place(screen);
  }
  stage.onCameraMove(placeNote);

  /** Fly to the item, then name it. Arrived, or the visitor grabbed the camera: either way the note shows. */
  async function go(item: T, mine: number): Promise<void> {
    arrived = false;
    await stage.flyTo(item, reducedMotion.matches);
    if (mine !== run) return;
    arrived = true;
    if (item.names.length === 0) return;
    placeNote();
    await note.show(item.names.slice(0, MAX_NAMES));
  }

  function sound(item: T): void {
    player.setTitle(item.title);
    // a missing or undecodable track must not break the flight; the player already signals lost sound itself
    void player.play(item.audioId).catch((e: unknown) => console.warn(`no sound for ${item.id}`, e));
  }

  function deselect(): void {
    selected = null;
    arrived = false;
    player.setTitle(null);
    run++;
    dex.select(null);
    note.hide();
    void player.play(null);
  }

  function pick(item: T): void {
    if (selected?.id === item.id) {
      deselect();
      return;
    }
    selected = item;
    opts.onPick?.(item);
    const mine = ++run;
    dex.select(item.id);
    note.hide();
    sound(item);
    void go(item, mine);
  }

  const dex = createDex(opts.host, opts.items, {
    kind: opts.kind,
    label: opts.label,
    onPick: pick,
    onHover: (item) => player.preload(item.audioId),
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && awake && selected && !document.querySelector('dialog[open]')) deselect();
  });

  return {
    reveal: () => dex.reveal(),
    sleep() {
      awake = false;
      run++;
      note.hide();
      if (selected) void player.play(null);
    },
    wake() {
      awake = true;
      const item = selected;
      if (!item) return;
      const mine = ++run;
      sound(item);
      if (arrived) {
        placeNote();
        if (item.names.length > 0) void note.show(item.names.slice(0, MAX_NAMES));
      } else {
        void go(item, mine);
      }
    },
  };
}

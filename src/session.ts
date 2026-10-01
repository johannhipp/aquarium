/** Tiny event hub so features that live outside the globe/index code can follow what the visitor does. */

type ViewListener = (creatureId: string) => void;

const viewListeners: ViewListener[] = [];

/** Called whenever a creature is picked from the index (not when it is deselected). */
export function onCreatureView(cb: ViewListener): void {
  viewListeners.push(cb);
}

export function emitCreatureView(creatureId: string): void {
  for (const cb of viewListeners) cb(creatureId);
}

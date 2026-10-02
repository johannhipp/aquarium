import { getJson, isDict, pair, parseNames, str, type AudioEntry, type LocalName } from './data';
import type { GuideItem } from './guide';
import type { MapPoint } from './cubeworld';

/** A bookmarked place on the Minato map: its sprite, its sound, its Japanese name and where it is. */
export interface Place extends GuideItem, MapPoint {}

function parsePlace(v: unknown, names: ReadonlyMap<string, LocalName[]>, audio: ReadonlyMap<string, AudioEntry>): Place {
  if (!isDict(v)) throw new Error('places.json: entry is not an object');
  const id = str(v.id, 'place.id');
  const [easting, northing] = pair(v.epsg6677, `${id}.epsg6677`);
  const audioId = `place:${id}`;
  if (!audio.has(audioId)) console.warn(`${id}: no ${audioId} entry in audio.json yet`);
  const list = names.get(id) ?? [];
  return {
    id,
    label: str(v.name, `${id}.name`),
    sprite: str(v.sprite, `${id}.sprite`),
    audioId,
    names: list,
    title: list[0]?.name ?? null,
    easting,
    northing,
  };
}

/**
 * The places of `public/places/places.json` (an entry's `fallback` is a candidate that lost to it and is
 * never shown). Names come from `place-names.json`; sound from the same audio.json as the creatures.
 */
export async function loadPlaces(audio: ReadonlyMap<string, AudioEntry>): Promise<Place[]> {
  const [places, names] = await Promise.all([
    getJson('/places/places.json'),
    getJson('/places/place-names.json').then((v) => parseNames(v, 'place-names.json')),
  ]);
  if (!Array.isArray(places)) throw new Error('places.json: expected an array');
  return places.map((p) => parsePlace(p, names, audio));
}

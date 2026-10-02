/**
 * The camera's hop between two places, like the globe's eased great-circle flight but for a flat map: zoom out,
 * slide, zoom in. The plan is a pure function of progress u in 0..1, so the chunk manager can sample it before
 * the flight starts and fetch what every sample will see.
 */

export interface FlightPose {
  /** world metres, x east, z south: the point the view is centred on */
  x: number;
  z: number;
  /** orbit-camera zoom */
  zoom: number;
}

export interface FlightPlan {
  from: FlightPose;
  to: FlightPose;
  durationMs: number;
  distance: number;
  /** pose at progress u (0..1) */
  at(u: number): FlightPose;
}

/** Half the visible height in metres at zoom 1. */
export const BASE_HALF_HEIGHT = 64;

function smootherstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/**
 * Progress along the ground is held back until the camera has risen (the middle 70% of the time) and the zoom
 * dips in proportion to the distance, so the hop is as high as the trip is long: the peak view is wide enough to
 * show about half the distance either side of the midpoint, and a short hop barely rises.
 */
export function planFlight(from: FlightPose, to: FlightPose): FlightPlan {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const durationMs = Math.min(4500, Math.max(1600, 1300 + 650 * Math.log2(1 + distance / 400)));
  const lz0 = Math.log(from.zoom);
  const lz1 = Math.log(to.zoom);
  const mean = (lz0 + lz1) / 2;
  const peak = Math.log(BASE_HALF_HEIGHT / (0.55 * distance + BASE_HALF_HEIGHT));
  const dip = Math.max(mean - Math.min(peak, mean), 0.35 * Math.min(1, distance / 150));
  return {
    from,
    to,
    durationMs,
    distance,
    at(u: number): FlightPose {
      const slide = smootherstep((u - 0.15) / 0.7);
      const hop = smootherstep(u / 0.4) * (1 - smootherstep((u - 0.6) / 0.4));
      const lz = lz0 + (lz1 - lz0) * smootherstep(u) - dip * hop;
      return { x: from.x + (to.x - from.x) * slide, z: from.z + (to.z - from.z) * slide, zoom: Math.exp(lz) };
    },
  };
}

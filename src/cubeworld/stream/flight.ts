/**
 * The camera's flight between two places on the flat map. The plan is a pure function of progress u in 0..1,
 * so the chunk manager can sample it before the flight starts and fetch what every sample will see.
 *
 * It is the optimal zoom-and-pan path of van Wijk and Nuij (2003, "Smooth and efficient zooming and panning"),
 * with the usual rho = 1.4: in the space of (position along the trip, visible width) it is the shortest path
 * under a metric that makes zooming and panning cost the same, so the camera rises exactly as much as the trip
 * needs and no more:
 *  - a trip shorter than a screen is a pan that dips out by a few percent at most;
 *  - a trip of a few screens arcs to a peak a little wider than the trip itself (both ends stay on screen with
 *    a margin), so a short hop is a low arc and a long one a high arc;
 *  - the time is proportional to the length of that path, which for long trips is the log of distance over
 *    screen width, so doubling a very long trip adds a fixed amount of time rather than doubling it.
 * The old planner rose to 0.55 x the distance plus a base height whatever the start zoom was, so a 300 m move
 * climbed to 800 m of view width.
 */

export interface FlightPose {
  /** world metres, x east, z south: the point the view is centred on */
  x: number;
  z: number;
  /** orbit-camera zoom */
  zoom: number;
}

/** What the planner needs to know about the screen and the camera heading. */
export interface FlightView {
  /** viewport width / height */
  aspect: number;
  /** orbit azimuth and polar angle (radians), as `OrbitControls` reports them */
  azimuth: number;
  polar: number;
  /** the camera cannot zoom out further than this */
  minZoom: number;
}

export interface FlightPlan {
  from: FlightPose;
  to: FlightPose;
  durationMs: number;
  /** ground distance in metres */
  distance: number;
  /** the widest the view gets, in metres across the screen, and the zoom there */
  peakWidth: number;
  peakZoom: number;
  /** pose at progress u (0..1) */
  at(u: number): FlightPose;
}

/** Half the visible height in metres at zoom 1. */
export const BASE_HALF_HEIGHT = 64;

/** van Wijk and Nuij's rho: how much zoom the path trades for pan (1.4 is their recommended compromise). */
const RHO = 1.4;
/** The peak view is this much wider than the trip needs, so both ends keep a margin from the screen edge. */
const MARGIN = 1.2;
/** Flight time: a base, plus this per unit of path length (natural-log units of width, divided by rho). */
const BASE_MS = 600;
const PER_UNIT_MS = 430;
const MIN_MS = 650;
const MAX_MS = 4200;

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * The trip as the screen sees it, in metres across the screen: the ground vector's component along the screen's
 * horizontal, or along its vertical (foreshortened by the tilt) times the aspect ratio, whichever needs the wider
 * view to hold both ends.
 */
function screenReach(dx: number, dz: number, view: FlightView): number {
  const sx = dx * Math.cos(view.azimuth) - dz * Math.sin(view.azimuth);
  const sy = (-dx * Math.sin(view.azimuth) - dz * Math.cos(view.azimuth)) * Math.cos(view.polar);
  return Math.max(Math.abs(sx), Math.abs(sy) * view.aspect);
}

export function planFlight(from: FlightPose, to: FlightPose, view: FlightView): FlightPlan {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  const k = 2 * BASE_HALF_HEIGHT * view.aspect; // visible width = k / zoom
  const w0 = k / from.zoom;
  const w1 = k / to.zoom;
  const u1 = screenReach(dx, dz, view) * MARGIN;

  /** (fraction of the way along the ground, visible width) after path length s */
  let curve: (s: number) => { frac: number; width: number };
  let length: number;
  if (u1 < 1e-3 * Math.min(w0, w1)) {
    // pure zoom (or nothing): width changes exponentially, the camera stays put
    const sign = Math.sign(w1 - w0);
    length = Math.abs(Math.log(w1 / w0)) / RHO;
    curve = (s) => ({ frac: length > 0 ? s / length : 1, width: w0 * Math.exp(sign * RHO * s) });
  } else {
    const rho2 = RHO * RHO;
    const rho4 = rho2 * rho2;
    const b0 = (w1 * w1 - w0 * w0 + rho4 * u1 * u1) / (2 * w0 * rho2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * u1 * u1) / (2 * w1 * rho2 * u1);
    const r0 = Math.asinh(-b0);
    const r1 = Math.asinh(-b1);
    length = (r1 - r0) / RHO;
    curve = (s) => ({
      frac: Math.min(1, Math.max(0, ((w0 / rho2) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0))) / u1)),
      width: (w0 * Math.cosh(r0)) / Math.cosh(RHO * s + r0),
    });
  }

  const durationMs = Math.min(MAX_MS, Math.max(MIN_MS, BASE_MS + PER_UNIT_MS * length));
  const zoomAt = (width: number): number => Math.max(view.minZoom, k / width);

  // the peak of the path: the widest sample (the curve is unimodal, 64 samples locate it to well under 1 %)
  let peakWidth = Math.max(w0, w1);
  for (let i = 0; i <= 64; i++) peakWidth = Math.max(peakWidth, curve((length * i) / 64).width);

  return {
    from,
    to,
    durationMs,
    distance,
    peakWidth: k / zoomAt(peakWidth),
    peakZoom: zoomAt(peakWidth),
    at(u: number): FlightPose {
      const { frac, width } = curve(length * smoothstep(u));
      return { x: from.x + dx * frac, z: from.z + dz * frac, zoom: zoomAt(width) };
    },
  };
}

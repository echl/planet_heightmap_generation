// Globe relief: how far a cell's elevation pushes its surface out from the sphere.
//
// Exaggerated (default): radius = 1 + 0.04 * elevation (ocean floor scaled by 0.3), which makes
// the mountains easy to see. Realistic: radius = 1 + height / 6371 km with the real height from
// elevToHeightKm, so the tallest peak (6 km) is under 0.1% of the radius, as on Earth.

import { state } from './state.js';
import { elevToHeightKm } from './color-map.js';

const EARTH_KM = 6371;
const EXAGGERATION = 0.04;
const REALISTIC_MAX_LIFT = 0.0004;   // overlays stay within ~2.5 km of the surface when realistic

// Radius (planet = 1) of a surface point with the given elevation. `lift` raises overlays
// (borders, wireframe, rivers) above the terrain; it is capped in realistic mode, where the whole
// relief is only about 0.001 deep.
export function reliefDisp(e, lift = 0) {
    if (state.realisticRelief) {
        return 1 + elevToHeightKm(e) / EARTH_KM + (lift < REALISTIC_MAX_LIFT ? lift : REALISTIC_MAX_LIFT);
    }
    return 1 + (e > 0 ? e * EXAGGERATION : e * EXAGGERATION * 0.3) + lift;
}

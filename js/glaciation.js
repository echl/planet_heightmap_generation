// Glaciation: ice sheets and their consequences for the terrain.
//
// An ice field (thickness per cell) drives, in order:
//   - erosion (the existing carving/widening/overdeepening/fjord step in terrain-post.js, fed an
//     ice index derived from the thickness field),
//   - deposition: end moraines at the ice margin, flattened till plains under the former ice,
//     outwash plains downstream of the margin, and a loess layer downwind,
//   - isostasy: the crust under the ice is pushed down and rebounds slowly after the ice goes,
//   - sea level: ice volume lowers the sea (up to about 125 m at the glacial maximum), which
//     exposes continental shelves,
// all controlled by one "glacial phase" (0 = today / interglacial, 1 = glacial maximum). The phase
// also sets a global cooling that the climate model receives as a temperature offset.
// Hydrology (hydrology.js) reads the ice thickness for its glacier outflow routing.

import { elevToHeightKm } from './color-map.js';
import {
    GLACIAL_LAT_DIVISOR, GLACIAL_ELEV_LOW, GLACIAL_ELEV_HIGH,
    GLACIAL_ELEV_FACTOR_SCALE, GLACIAL_ELEV_FACTOR_LAT_BASE, GLACIAL_ELEV_FACTOR_LAT_SCALE,
} from './terrain-config.js';

export const GLACIAL = {
    // Last Glacial Maximum: sea level ~125 m lower, global temperature ~6 C colder.
    seaDropKm: 0.125,
    deltaTC: -6,
    // Ice thickness profile of an ice sheet: H = iceCoef * sqrt(distance from the margin, km)
    // (a parabolic profile; 3.1 km at 2000 km from the edge, like the Laurentide dome).
    iceCoef: 0.07,
    iceMaxKm: 3.5,
    iceIndexMin: 0.15,           // glaciation index above which a cell counts as ice-covered
    // Ice extent relative to the full (maximum-phase) extent: today's ice is a fraction of it.
    extentBase: 0.45,
    extentGain: 0.55,
    // Isostasy: crust depression = isoFrac * ice thickness (ice/mantle density ratio ~0.3),
    // relaxing back with time constant tauYears after the maximum (yearsSinceMax at phase 0).
    isoFrac: 0.30,
    yearsSinceMax: 21000,
    tauYears: 7000,
    // Deposition (elevation units)
    morainePeak: 0.020,
    outwashDeposit: 0.020,
    outwashSteps: 5,
    tillSmooth: 0.5,
    tillMaxElev: 0.35,
    loessHops: 4,
    earthRadiusKm: 6371,
};

// Inverse of elevToHeightKm.
export function heightKmToElev(km) {
    if (km <= 0) return km / 10;
    if (km >= 6) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
        const mid = 0.5 * (lo + hi);
        if (elevToHeightKm(mid) < km) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

function smoothstep(x, e0, e1) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/** Phase-dependent quantities. */
export function glacialPhaseParams(phase) {
    const p = Math.max(0, Math.min(1, phase || 0));
    return {
        phase: p,
        seaDropKm: GLACIAL.seaDropKm * p,
        deltaTC: GLACIAL.deltaTC * p,
        extentScale: GLACIAL.extentBase + GLACIAL.extentGain * p,
        relax: Math.exp(-(1 - p) * GLACIAL.yearsSinceMax / GLACIAL.tauYears),
    };
}

/** Glaciation index per cell (0..1): high latitude and high altitude land. */
function iceIndex(mesh, r_xyz, r_elevation, r_isOcean, strength) {
    const N = mesh.numRegions;
    const idx = new Float32Array(N);
    if (!(strength > 0)) return idx;
    const thresholdLat = Math.PI / 2 - strength * Math.PI / GLACIAL_LAT_DIVISOR;
    for (let r = 0; r < N; r++) {
        if (r_isOcean[r]) continue;
        const y = r_xyz[3 * r + 1];
        const polarDist = Math.abs(Math.asin(Math.max(-1, Math.min(1, y))));
        const latFactor = smoothstep(polarDist, thresholdLat, Math.PI / 2);
        const elevFactor = smoothstep(r_elevation[r], GLACIAL_ELEV_LOW, GLACIAL_ELEV_HIGH);
        const latScale = smoothstep(polarDist, Math.PI / 8, Math.PI / 3);
        idx[r] = Math.max(latFactor, elevFactor * GLACIAL_ELEV_FACTOR_SCALE * (GLACIAL_ELEV_FACTOR_LAT_BASE + GLACIAL_ELEV_FACTOR_LAT_SCALE * latScale)) * strength;
    }
    return idx;
}

/**
 * Ice field for a glaciation strength: which cells are ice-covered and how thick the ice is.
 * @returns {{idx:Float32Array, isIce:Uint8Array, thicknessKm:Float32Array, margin:Uint8Array}}
 */
export function computeIce(mesh, r_xyz, r_elevation, r_isOcean, strength) {
    const N = mesh.numRegions, { adjOffset, adjList } = mesh;
    const idx = iceIndex(mesh, r_xyz, r_elevation, r_isOcean, strength);
    const isIce = new Uint8Array(N);
    const thicknessKm = new Float32Array(N);
    const margin = new Uint8Array(N);
    let any = false;
    for (let r = 0; r < N; r++) if (!r_isOcean[r] && idx[r] >= GLACIAL.iceIndexMin) { isIce[r] = 1; any = true; }
    if (!any) return { idx, isIce, thicknessKm, margin };

    // Distance (in cells) from the margin: the margin is an ice cell with a non-ice neighbour.
    const dist = new Int32Array(N).fill(-1);
    let queue = [];
    for (let r = 0; r < N; r++) {
        if (!isIce[r]) continue;
        for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) {
            if (!isIce[adjList[j]]) { margin[r] = 1; dist[r] = 0; queue.push(r); break; }
        }
    }
    // (an ice cap with no margin cell at all cannot happen on a sphere with ocean/land mix, but guard it)
    if (queue.length === 0) for (let r = 0; r < N; r++) if (isIce[r]) { dist[r] = 0; queue.push(r); break; }
    for (let qi = 0; qi < queue.length; qi++) {
        const r = queue[qi];
        for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) {
            const nb = adjList[j];
            if (isIce[nb] && dist[nb] < 0) { dist[nb] = dist[r] + 1; queue.push(nb); }
        }
    }
    const cellAreaKm2 = 4 * Math.PI * GLACIAL.earthRadiusKm * GLACIAL.earthRadiusKm / N;
    const edgeKm = 1.075 * Math.sqrt(cellAreaKm2);
    for (let r = 0; r < N; r++) {
        if (!isIce[r]) continue;
        const d = (dist[r] < 0 ? 0 : dist[r]) * edgeKm + 0.5 * edgeKm;
        const vigor = 0.5 + 0.8 * Math.min(1, idx[r]);
        thicknessKm[r] = Math.min(GLACIAL.iceMaxKm, GLACIAL.iceCoef * Math.sqrt(d) * vigor);
    }
    return { idx, isIce, thicknessKm, margin };
}

/** Ice index handed to the erosion step: thicker (interior) ice carves harder. */
export function erosionIceIndex(ice) {
    const out = new Float32Array(ice.idx.length);
    for (let r = 0; r < out.length; r++) {
        if (!ice.isIce[r]) continue;
        out[r] = ice.idx[r] * (0.5 + 0.5 * Math.min(1, ice.thicknessKm[r] / 2));
    }
    return out;
}

/**
 * Depositional landforms of the (maximum) ice: end moraine at the margin, till plains under the
 * ice, outwash plains downstream, and loess downwind. Modifies r_elevation.
 * @returns {{glacialDeposits:Float32Array, loess:Float32Array}}  deposits: 1 moraine, 2 till, 3 outwash
 */
export function applyGlacialDeposits(mesh, r_xyz, r_elevation, r_isOcean, ice) {
    const N = mesh.numRegions, { adjOffset, adjList } = mesh;
    const deposits = new Float32Array(N);
    const loess = new Float32Array(N);
    const { isIce, thicknessKm, margin } = ice;
    const G = GLACIAL;

    // Till plains: smooth low ice-covered ground (drumlin-like subdued relief).
    const before = new Float32Array(r_elevation);
    for (let r = 0; r < N; r++) {
        if (!isIce[r] || margin[r] || r_isOcean[r] || before[r] > G.tillMaxElev) continue;
        let sum = 0, n = 0;
        for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) { const nb = adjList[j]; if (!r_isOcean[nb]) { sum += before[nb]; n++; } }
        if (n === 0) continue;
        r_elevation[r] = before[r] * (1 - G.tillSmooth) + (sum / n) * G.tillSmooth;
        deposits[r] = 2;
    }

    // End moraine: a ridge on the ice margin, thicker ice leaves a bigger one; a weaker apron outside.
    const outerStarts = [];
    for (let r = 0; r < N; r++) {
        if (!margin[r] || r_isOcean[r]) continue;
        const k = Math.min(1, thicknessKm[r] / 1.5);
        r_elevation[r] += G.morainePeak * (0.4 + 0.6 * k);
        deposits[r] = 1;
        for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) {
            const nb = adjList[j];
            if (isIce[nb] || r_isOcean[nb]) continue;
            r_elevation[nb] += 0.4 * G.morainePeak * (0.4 + 0.6 * k) / 3;
            outerStarts.push(nb);
        }
    }

    // Outwash plains: from the outer margin, follow the steepest descent a few cells and lay down
    // a flatter, slightly raised sediment ramp (sandur).
    const seenOut = new Uint8Array(N);
    for (const s of outerStarts) {
        let c = s;
        for (let k = 0; k < G.outwashSteps; k++) {
            if (r_isOcean[c] || isIce[c]) break;
            if (!seenOut[c]) {
                seenOut[c] = 1;
                if (deposits[c] === 0) deposits[c] = 3;
                r_elevation[c] += G.outwashDeposit * (1 - k / (G.outwashSteps + 1));
            }
            let best = -1, bestE = r_elevation[c];
            for (let j = adjOffset[c], e = adjOffset[c + 1]; j < e; j++) {
                const nb = adjList[j];
                if (r_isOcean[nb] || isIce[nb]) continue;
                if (r_elevation[nb] < bestE) { bestE = r_elevation[nb]; best = nb; }
            }
            if (best < 0) break;
            // flatten toward the receiver so the ramp is gentle
            r_elevation[c] = 0.5 * r_elevation[c] + 0.5 * Math.max(bestE, r_elevation[c] - 0.01);
            c = best;
        }
    }

    // Loess: wind-blown silt downwind of the margin and outwash plains. Prevailing wind direction
    // by latitude: westerlies (blowing east) at 30-60 deg, easterlies elsewhere (blowing west).
    let frontier = [];
    for (let r = 0; r < N; r++) if (deposits[r] === 1 || deposits[r] === 3) { loess[r] = 0; frontier.push(r); }
    const hop = new Int8Array(N).fill(-1);
    for (const r of frontier) hop[r] = 0;
    for (let h = 0; h < G.loessHops; h++) {
        const next = [];
        for (const c of frontier) {
            const px = r_xyz[3 * c], py = r_xyz[3 * c + 1], pz = r_xyz[3 * c + 2];
            const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, py)))) * 180 / Math.PI;
            const sign = (lat >= 30 && lat < 60) ? 1 : -1;
            // east vector at c
            let ex = pz, ez = -px; const el = Math.hypot(ex, ez) || 1; ex = sign * ex / el; ez = sign * ez / el;
            for (let j = adjOffset[c], e = adjOffset[c + 1]; j < e; j++) {
                const nb = adjList[j];
                if (hop[nb] >= 0 || r_isOcean[nb] || isIce[nb]) continue;
                let dx = r_xyz[3 * nb] - px, dz = r_xyz[3 * nb + 2] - pz;
                const dl = Math.hypot(dx, dz, r_xyz[3 * nb + 1] - py) || 1;
                if ((dx * ex + dz * ez) / dl < 0.3) continue;
                hop[nb] = h + 1; loess[nb] = 1 - (h + 1) / (G.loessHops + 1);
                next.push(nb);
            }
        }
        frontier = next;
    }
    return { glacialDeposits: deposits, loess };
}

/**
 * Isostatic depression under the (maximum) ice and the sea-level shift of the glacial phase.
 * Works in kilometres of true height, then converts back to the mesh's elevation units.
 * Modifies r_elevation; returns the depression (km, positive = pushed down) and ice present now.
 */
export function applyIsostasyAndSeaLevel(mesh, r_elevation, iceMaxThicknessKm, iceNow, phaseParams) {
    const N = mesh.numRegions;
    const depression = new Float32Array(N);
    const { seaDropKm, relax } = phaseParams;
    for (let r = 0; r < N; r++) {
        const dep = GLACIAL.isoFrac * iceMaxThicknessKm[r] * relax;
        depression[r] = dep;
        const dKm = seaDropKm - dep;
        if (Math.abs(dKm) < 1e-7) continue;
        const e = r_elevation[r];
        let e2 = heightKmToElev(elevToHeightKm(e) + dKm);
        if (iceNow && iceNow[r] && e > 0 && e2 <= 0) e2 = 0.0003;    // grounded ice stays land
        r_elevation[r] = e2;
    }
    return depression;
}

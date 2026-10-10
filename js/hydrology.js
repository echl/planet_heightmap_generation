// Hydrology: flow routing, river discharge, lakes, and groundwater.
//
// Method (all on the final elevation field, so it always matches what is drawn):
//   1. Priority-flood (Barnes et al.) from the ocean inward. Every land cell gets a
//      downstream neighbour (r_flowTo) and a "filled surface". A cell whose filled
//      surface is above its own elevation sits inside a closed depression: that
//      depression is a lake, and its water level is the spill height.
//   2. Groundwater (optional, HYDROLOGY.groundwater): part of each cell's runoff
//      infiltrates (more on flat, permeable ground such as sedimentary basins; less
//      on steep or crystalline ground). The water table follows a heavily smoothed
//      copy of the land surface, and groundwater flows down that smoothed head with
//      its own flood-routing tree (so aquifer catchments differ from surface ones).
//      Wherever the real surface drops below the water table (valleys, lake basins)
//      groundwater emerges as baseflow, springs and oases.
//   3. Discharge: surface runoff + baseflow is accumulated down the surface flow
//      tree in reverse flood order; in arid, permeable ground a river loses part of
//      its flow back into the ground (losing streams).
//   4. Rivers: land cells whose discharge exceeds physical-area thresholds.
//
// Everything is expressed in physical units (km^2, km), never raw cell counts, so the
// result looks the same at any Detail setting (see CLAUDE.md "scale invariance").
// "Water" quantities are runoff-weighted catchment area in km^2: one unit of area
// receiving the reference runoff.

import { elevToHeightKm } from './color-map.js';

export const HYDROLOGY = {
    earthRadiusKm: 6371,
    // Lakes: a filled depression must be at least this deep and this large.
    minLakeDepthKm: 0.002,
    minLakeAreaKm2: 1000,
    // Runoff weight from mean precipitation p (normalised 0..~1.35 by the climate model):
    //   w = clamp((p - offset) / scale, 0, max)
    runoffPrecipOffset: 0.10,
    runoffPrecipScale: 0.60,
    runoffMax: 1.6,
    // Discharge thresholds (runoff-weighted catchment area, km^2) for stream classes 1..4:
    // stream, river, major river, great river.
    riverThresholdsKm2: [60000, 220000, 800000, 2500000],
    // River ribbons (river-lines.js): drawn for discharge >= riverLineMinKm2, with real width
    // w = k * sqrt(Q / 1e6 km^2) km (about 3 km at 1 million km^2), never thinner than 1 pixel.
    riverLineMinKm2: 20000,
    riverWidthKmPerSqrtMkm2: 3.0,

    // ── Cold climate (needs the temperature layers; otherwise ignored) ──
    // Where even the warm-season mean is at or below iceWarmSeasonC there is no melt season: snow
    // accumulates as permanent ice, so the cell sheds no local runoff. Its precipitation leaves as
    // glacier outflow and emerges at the first ice-free cell downstream (calving into the sea is lost).
    iceWarmSeasonC: 0,
    // Frozen ground infiltrates little. Infiltration is scaled down linearly with the annual mean
    // temperature from permafrostStartC (no effect) to permafrostFullC (max reduction).
    permafrostStartC: -2,
    permafrostFullC: -10,
    permafrostMaxReduction: 0.85,

    // ── Seasons (needs the temperature layers; otherwise every month is the same) ──
    // Monthly forcing is a cosine between the climate model's summer and winter fields; the
    // summer extreme falls in month summerMonth (0 = January; the model's summer is the northern one).
    summerMonth: 6,
    petRefC: 15,                // temperature at which evaporation equals runoffPrecipOffset
    petMaxFactor: 2.5,          // ... and its cap, as a multiple of that offset
    meltPerDegC: 0.09,          // snowmelt per degree above 0 C per month, in precipitation units (~90 mm)
    snowCap: 10,                // snowpack cap (precipitation units)

    // ── Groundwater ──
    groundwater: true,
    infiltrationMax: 0.55,      // fraction of runoff that infiltrates on perfectly permeable ground
    slopeScale: 0.02,           // km/km grade at which slope halves permeability (2 %)
    geoBase: 0.45,              // geology permeability: base ...
    geoBasin: 1.2,              // ... + sedimentary basin weight
    geoCraton: 0.5,             // ... - crystalline craton weight
    geoFoldBelt: 0.25,          // ... - fold-belt (fractured bedrock) weight
    geoMin: 0.15,
    headSmoothingKm: 300,       // distance the water-table head is smoothed over (regional aquifers)
    headMaxPasses: 120,         // cost cap at very high detail
    tableDepthHumidKm: 0.005,   // water table depth below the smoothed surface, humid ground
    tableDepthAridKm: 0.08,     // ... and arid ground
    emergenceScaleKm: 0.01,     // how far the surface must sit below the table for full emergence
    lossPerKm: 0.0025,          // river loss rate per km of fully arid, fully permeable ground (1/km)
    lossIterations: 2,          // passes of surface routing <-> aquifer routing so stream losses recharge the aquifer (0 = losses vanish)
    lossBigKm2: 1000000,        // flow above this loses proportionally less (big exotic rivers persist)
    aridityPrecip: 0.35,        // precipitation at/above which ground counts as humid
    springMinKm2: 3000,         // minimum baseflow for a cell to count as a spring
    oasisPrecip: 0.25,          // spring below this mean precipitation is an oasis
};

// ── Binary min-heap over cell indices, keyed by a Float32Array ──────────────
class CellHeap {
    constructor(key, capacity) {
        this.key = key;
        this.data = new Int32Array(Math.max(16, capacity));
        this.size = 0;
    }
    _less(a, b) {
        const ka = this.key[a], kb = this.key[b];
        return ka < kb || (ka === kb && a < b);
    }
    push(r) {
        if (this.size === this.data.length) {
            const nd = new Int32Array(this.data.length * 2);
            nd.set(this.data);
            this.data = nd;
        }
        const d = this.data;
        let i = this.size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!this._less(r, d[p])) break;
            d[i] = d[p];
            i = p;
        }
        d[i] = r;
    }
    pop() {
        const d = this.data;
        const top = d[0];
        const last = d[--this.size];
        if (this.size > 0) {
            let i = 0;
            const n = this.size;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= n) break;
                if (c + 1 < n && this._less(d[c + 1], d[c])) c++;
                if (!this._less(d[c], last)) break;
                d[i] = d[c];
                i = c;
            }
            d[i] = last;
        }
        return top;
    }
}

/**
 * Priority-flood from the ocean inward over `elev`.
 * Returns the filled surface, the downstream neighbour of every land cell, and the
 * land cells in the order they were flooded (downstream cells always come first).
 */
function floodRoute(mesh, elev, isOcean, oceanCount) {
    const N = mesh.numRegions;
    const { adjOffset, adjList } = mesh;
    const surface = new Float32Array(elev);
    const flowTo = new Int32Array(N).fill(-1);
    const visited = new Uint8Array(N);
    const order = new Int32Array(N - oceanCount);
    let nOrder = 0;
    const heap = new CellHeap(surface, 1024);

    for (let r = 0; r < N; r++) if (isOcean[r]) visited[r] = 1;
    for (let r = 0; r < N; r++) {
        if (isOcean[r]) continue;
        // seed: land cells touching the ocean
        let bestOcean = -1, bestElev = Infinity;
        for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) {
            const nb = adjList[j];
            if (isOcean[nb] && elev[nb] < bestElev) { bestElev = elev[nb]; bestOcean = nb; }
        }
        if (bestOcean >= 0) {
            visited[r] = 1;
            flowTo[r] = bestOcean;
            heap.push(r);
        }
    }
    if (heap.size === 0 && oceanCount < N) {
        // No ocean at all (extreme desert world): treat the lowest land cell as a terminal sink.
        let lo = -1;
        for (let r = 0; r < N; r++) if (!isOcean[r] && (lo < 0 || elev[r] < elev[lo])) lo = r;
        visited[lo] = 1;
        heap.push(lo);
    }
    while (heap.size > 0) {
        const c = heap.pop();
        order[nOrder++] = c;
        const sc = surface[c];
        for (let j = adjOffset[c], e = adjOffset[c + 1]; j < e; j++) {
            const nb = adjList[j];
            if (visited[nb]) continue;
            visited[nb] = 1;
            if (surface[nb] < sc) surface[nb] = sc;   // fill the depression up to its spill height
            flowTo[nb] = c;
            heap.push(nb);
        }
    }
    return { surface, flowTo, order, nOrder };
}

/**
 * @param {SphereMesh} mesh
 * @param {Float32Array} r_elevation   per-region elevation (<= 0 is ocean)
 * @param {Float32Array|null} precipA  per-region precipitation (e.g. summer), or null
 * @param {Float32Array|null} precipB  per-region precipitation (e.g. winter), or null
 * @param {{overrides?:object, basinWeight?:Float32Array, cratonWeight?:Float32Array,
 *          foldBeltWeight?:Float32Array}} [opts]  optional geology layers and config overrides
 * @returns {{
 *   r_flowTo: Int32Array,        downstream neighbour (-1 for ocean / terminal)
 *   r_discharge: Float32Array,   runoff-weighted flow leaving the cell, km^2 (land cells)
 *   r_river: Uint8Array,         0 = none, 1..4 = stream class
 *   r_lake: Uint8Array,          1 = lake cell
 *   r_lakeLevel: Float32Array,   lake surface elevation (internal units) for lake cells
 *   r_recharge: Float32Array,    water infiltrating into the ground, km^2 (groundwater on)
 *   r_baseflow: Float32Array,    groundwater emerging at the surface, km^2
 *   r_waterTable: Float32Array,  depth of the water table below the surface, km (0 in valleys)
 *   r_spring: Uint8Array,        0 = none, 1 = spring, 2 = oasis
 *   stats: object
 * }}
 */
export function computeHydrology(mesh, r_elevation, precipA, precipB, opts) {
    const o = opts || {};
    const tempA = o.tempSummer || null, tempB = o.tempWinter || null;     // 0-1 normalised, -45..+45 C
    const H = o.overrides ? { ...HYDROLOGY, ...o.overrides } : HYDROLOGY;
    const N = mesh.numRegions;
    const { adjOffset, adjList } = mesh;
    const cellAreaKm2 = 4 * Math.PI * H.earthRadiusKm * H.earthRadiusKm / N;
    const edgeKm = 1.075 * Math.sqrt(cellAreaKm2);   // typical neighbour spacing

    const isOcean = new Uint8Array(N);
    let oceanCount = 0;
    for (let r = 0; r < N; r++) {
        if (r_elevation[r] <= 0) { isOcean[r] = 1; oceanCount++; }
    }

    // ── 1. Surface flow routing ──
    const surf = floodRoute(mesh, r_elevation, isOcean, oceanCount);
    const { surface, flowTo, order, nOrder } = surf;

    // ── 2. Lakes: filled depressions that are deep and large enough ──
    const lakeCand = new Uint8Array(N);
    let candCount = 0;
    for (let r = 0; r < N; r++) {
        if (isOcean[r]) continue;
        if (surface[r] > r_elevation[r]) {
            const depthKm = elevToHeightKm(surface[r]) - elevToHeightKm(r_elevation[r]);
            if (depthKm >= H.minLakeDepthKm) { lakeCand[r] = 1; candCount++; }
        }
    }
    const r_lake = new Uint8Array(N);
    const r_lakeLevel = new Float32Array(N);
    const minLakeCells = Math.max(1, Math.round(H.minLakeAreaKm2 / cellAreaKm2));
    let lakeCount = 0, lakeCells = 0, largestLake = 0;
    if (candCount > 0) {
        const seen = new Uint8Array(N);
        const stack = [];
        for (let r0 = 0; r0 < N; r0++) {
            if (!lakeCand[r0] || seen[r0]) continue;
            const comp = [];
            seen[r0] = 1;
            stack.push(r0);
            while (stack.length) {
                const c = stack.pop();
                comp.push(c);
                for (let j = adjOffset[c], e = adjOffset[c + 1]; j < e; j++) {
                    const nb = adjList[j];
                    if (lakeCand[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
                }
            }
            if (comp.length < minLakeCells) continue;
            lakeCount++;
            lakeCells += comp.length;
            if (comp.length > largestLake) largestLake = comp.length;
            for (let i = 0; i < comp.length; i++) { r_lake[comp[i]] = 1; r_lakeLevel[comp[i]] = surface[comp[i]]; }
        }
    }

    // ── 3. Runoff per land cell ──
    const hasClimate = !!(precipA || precipB);
    const pMean = hasClimate ? new Float32Array(N) : null;
    const runoff = new Float32Array(N);        // km^2 of runoff-weighted area
    for (let r = 0; r < N; r++) {
        if (isOcean[r]) continue;
        let w = 1;
        if (hasClimate) {
            const p = precipA && precipB ? 0.5 * (precipA[r] + precipB[r]) : (precipA ? precipA[r] : precipB[r]);
            pMean[r] = p;
            w = (p - H.runoffPrecipOffset) / H.runoffPrecipScale;
            if (w < 0) w = 0; else if (w > H.runoffMax) w = H.runoffMax;
        }
        runoff[r] = w * cellAreaKm2;
    }

    // ── 3b. Monthly runoff: rain, snowpack and melt, temperature-scaled evaporation ──
    // The annual `runoff` above is the no-season baseline. With temperature, each month gets its
    // own runoff weight; permanent-ice cells shed their annual share evenly to the ice margin.
    const NM = 12;
    const hasTemp = !!(tempA && tempB);
    const seasonal = hasClimate && hasTemp;
    const tMean = hasTemp ? new Float32Array(N) : null;       // annual mean, C
    const r_ice = new Uint8Array(N);
    let iceCells = 0, iceMeltKm2 = 0, iceCalvedKm2 = 0;
    const runoffM = [];
    const snowM = [];                                          // snowpack depth per month (precipitation units)
    for (let m = 0; m < NM; m++) snowM.push(new Float32Array(N));
    for (let m = 0; m < NM; m++) runoffM.push(new Float32Array(runoff));
    if (hasTemp) {
        for (let r = 0; r < N; r++) {
            if (isOcean[r]) continue;
            const ta = -45 + 90 * tempA[r], tb = -45 + 90 * tempB[r];
            tMean[r] = 0.5 * (ta + tb);
            if (!r_lake[r] && Math.max(ta, tb) <= H.iceWarmSeasonC) { r_ice[r] = 1; iceCells++; for (let m = 0; m < NM; m++) snowM[m][r] = H.snowCap; }
        }
    }
    if (seasonal) {
        const wS = new Float32Array(NM);
        for (let m = 0; m < NM; m++) wS[m] = 0.5 * (1 + Math.cos(2 * Math.PI * (m - H.summerMonth) / NM));
        const pa = precipA || precipB, pb = precipB || precipA;
        const E0 = H.runoffPrecipOffset, scale = H.runoffPrecipScale;
        for (let r = 0; r < N; r++) {
            if (isOcean[r] || r_ice[r]) continue;
            const Ts = -45 + 90 * tempA[r], Tw = -45 + 90 * tempB[r], Ps = pa[r], Pw = pb[r];
            let S = 0;                                          // snowpack, precipitation units
            for (let yr = 0; yr < 2; yr++) {                    // year 0 spins the snowpack up
                for (let m = 0; m < NM; m++) {
                    const T = wS[m] * Ts + (1 - wS[m]) * Tw, P = wS[m] * Ps + (1 - wS[m]) * Pw;
                    let w = 0;
                    if (T > 0) {
                        let E = E0 * T / H.petRefC;
                        if (E > E0 * H.petMaxFactor) E = E0 * H.petMaxFactor;
                        w = (P - E) / scale;
                        if (w < 0) w = 0; else if (w > H.runoffMax) w = H.runoffMax;
                        const melt = Math.min(S, H.meltPerDegC * T);
                        S -= melt;
                        w += NM * melt / scale;
                    } else {
                        S += P / NM;
                        if (S > H.snowCap) S = H.snowCap;
                    }
                    if (yr === 1) { runoffM[m][r] = w * cellAreaKm2; snowM[m][r] = S; }
                }
            }
        }
    }
    // Ice cells: no local runoff; their share is delivered to the first ice-free cell downstream
    // each month (calving into the sea is lost).
    if (iceCells) {
        const carry = new Float32Array(N);
        for (let m = 0; m < NM; m++) {
            const rm = runoffM[m];
            carry.fill(0);
            for (let i = nOrder - 1; i >= 0; i--) {             // upstream first
                const r = order[i];
                if (isOcean[r]) continue;
                if (r_ice[r]) {
                    const pass = rm[r] + carry[r];
                    rm[r] = 0;
                    const t = flowTo[r];
                    if (t >= 0 && !isOcean[t]) carry[t] += pass; else iceCalvedKm2 += pass / NM;
                } else if (carry[r] > 0) {
                    rm[r] += carry[r];
                    iceMeltKm2 += carry[r] / NM;
                }
            }
        }
    }
    // Annual mean runoff drives recharge and the aquifer.
    for (let r = 0; r < N; r++) {
        let sum = 0;
        for (let m = 0; m < NM; m++) sum += runoffM[m][r];
        runoff[r] = sum / NM;
    }

    // ── 4. Groundwater: recharge, aquifer flow, emergence as baseflow ──
    const useGw = !!H.groundwater;
    const r_recharge = new Float32Array(N);
    const r_baseflow = new Float32Array(N);
    const r_waterTable = new Float32Array(N);
    const perm = useGw ? new Float32Array(N) : null;
    const rechFactor = useGw ? new Float32Array(N) : null;   // share of a month's runoff that infiltrates
    const aridity = (useGw && hasClimate) ? new Float32Array(N) : null;
    const gw = { toSea: 0, rechargeTotal: 0, baseflowTotal: 0, passes: 0 };

    let gwr = null, phi = null;
    if (useGw) {
        // Land surface height in km (ocean = 0), and local grade from the steepest drop.
        const hk = new Float32Array(N);
        for (let r = 0; r < N; r++) hk[r] = isOcean[r] ? 0 : elevToHeightKm(r_elevation[r]);

        const bW = o.basinWeight, cW = o.cratonWeight, fW = o.foldBeltWeight;
        const haveGeo = !!(bW || cW || fW);
        for (let r = 0; r < N; r++) {
            if (isOcean[r]) continue;
            let drop = 0;
            for (let j = adjOffset[r], e = adjOffset[r + 1]; j < e; j++) {
                const d = hk[r] - hk[adjList[j]];
                if (d > drop) drop = d;
            }
            const slope = drop / edgeKm;
            const permSlope = 1 / (1 + (slope / H.slopeScale) * (slope / H.slopeScale));
            let geo = 0.6;
            if (haveGeo) {
                geo = H.geoBase + H.geoBasin * (bW ? bW[r] : 0) - H.geoCraton * (cW ? cW[r] : 0) - H.geoFoldBelt * (fW ? fW[r] : 0);
                if (geo < H.geoMin) geo = H.geoMin; else if (geo > 1) geo = 1;
            }
            perm[r] = permSlope * geo;
            if (aridity) {
                const a = 1 - pMean[r] / H.aridityPrecip;
                aridity[r] = a < 0 ? 0 : (a > 1 ? 1 : a);
            }
            // Open water does not infiltrate; everything else recharges in proportion to permeability.
            let frost = 1;
            if (tMean) {
                const f = (H.permafrostStartC - tMean[r]) / (H.permafrostStartC - H.permafrostFullC);
                frost = 1 - H.permafrostMaxReduction * (f < 0 ? 0 : (f > 1 ? 1 : f));
            }
            if (!r_lake[r]) { rechFactor[r] = H.infiltrationMax * perm[r] * frost; r_recharge[r] = rechFactor[r] * runoff[r]; }
        }

        // Water-table head: the land surface smoothed over ~headSmoothingKm (land only; the
        // sea is the 0 boundary). Passes grow with the square of the distance/spacing ratio.
        const halfD = H.headSmoothingKm / (2 * edgeKm);
        const passes = Math.max(1, Math.min(H.headMaxPasses, Math.round(2 * halfD * halfD)));
        gw.passes = passes;
        let cur = new Float32Array(hk), nxt = new Float32Array(N);   // never reuse hk as a scratch buffer
        const landList = new Int32Array(N - oceanCount);
        for (let r = 0, k = 0; r < N; r++) if (!isOcean[r]) landList[k++] = r;
        for (let p = 0; p < passes; p++) {
            for (let k = 0; k < landList.length; k++) {      // ocean cells stay at 0
                const r = landList[k];
                let sum = 0;
                const j0 = adjOffset[r], j1 = adjOffset[r + 1];
                for (let j = j0; j < j1; j++) sum += cur[adjList[j]];
                nxt[r] = 0.5 * cur[r] + 0.5 * sum / (j1 - j0);
            }
            const t = cur; cur = nxt; nxt = t;
        }
        const head = cur;

        // Aquifer flow routing over the smoothed head (ocean keeps its real elevation).
        const gwElev = new Float32Array(N);
        for (let r = 0; r < N; r++) gwElev[r] = isOcean[r] ? r_elevation[r] : head[r];
        gwr = floodRoute(mesh, gwElev, isOcean, oceanCount);

        // Water-table depth and emergence fraction per cell.
        phi = new Float32Array(N);
        for (let r = 0; r < N; r++) {
            if (isOcean[r]) continue;
            const a = aridity ? aridity[r] : 0;
            const delta = H.tableDepthHumidKm + (H.tableDepthAridKm - H.tableDepthHumidKm) * a;
            const tableH = head[r] - delta;
            const seep = tableH - hk[r];                  // > 0: surface is below the water table
            r_waterTable[r] = seep < 0 ? -seep : 0;
            let f = seep / H.emergenceScaleKm;
            if (f < 0) f = 0; else if (f > 1) f = 1;
            phi[r] = r_lake[r] ? 1 : f;
        }
    }

    // Groundwater accumulated down the aquifer tree (upstream first). Sources are rain recharge
    // plus water that losing streams leaked into the ground (r_lossRecharge).
    const r_lossRecharge = new Float32Array(N);
    const gIn = new Float32Array(N);
    const accumulateGroundwater = () => {
        gIn.fill(0); r_baseflow.fill(0);
        gw.toSea = 0; gw.rechargeTotal = 0; gw.baseflowTotal = 0; gw.lossRechargeTotal = 0;
        for (let i = gwr.nOrder - 1; i >= 0; i--) {
            const r = gwr.order[i];
            const g = r_recharge[r] + r_lossRecharge[r] + gIn[r];
            const b = phi[r] * g;
            r_baseflow[r] = b;
            const out = g - b;
            const t = gwr.flowTo[r];
            if (t >= 0 && !isOcean[t]) gIn[t] += out; else gw.toSea += out;
            gw.rechargeTotal += r_recharge[r];
            gw.lossRechargeTotal += r_lossRecharge[r];
            gw.baseflowTotal += b;
        }
    };

    // ── 5. Surface discharge, month by month: runoff + baseflow, minus losing-stream infiltration ──
    // Groundwater is steady (annual mean recharge), so baseflow is the same every month. Stream
    // losses are averaged over the year and fed back as recharge, and the aquifer is re-routed.
    const dischargeM = [];
    for (let m = 0; m < NM; m++) dischargeM.push(new Float32Array(N));
    const qIn = new Float32Array(N), qInMean = new Float32Array(N), lossAcc = new Float32Array(N);
    let lossTotal = 0;
    const routeAllMonths = () => {
        qInMean.fill(0); lossAcc.fill(0); lossTotal = 0;
        for (let m = 0; m < NM; m++) {
            const rm = runoffM[m], dm = dischargeM[m];
            qIn.fill(0);
            for (let i = nOrder - 1; i >= 0; i--) {             // upstream first
                const r = order[i];
                const q = (rm[r] - (rechFactor ? rechFactor[r] * rm[r] : 0)) + r_baseflow[r] + qIn[r];
                let loss = 0;
                if (aridity && !r_lake[r] && aridity[r] > 0 && qIn[r] > 0) {
                    const rate = H.lossPerKm * edgeKm * perm[r] * aridity[r];   // per cell, but derived from a per-km rate
                    loss = qIn[r] * (1 - Math.exp(-rate)) / (1 + qIn[r] / H.lossBigKm2);
                }
                lossAcc[r] += loss / NM;
                lossTotal += loss / NM;
                dm[r] = q - loss;
                qInMean[r] += qIn[r] / NM;
                const t = flowTo[r];
                if (t >= 0 && !isOcean[t]) qIn[t] += q - loss;
            }
        }
        r_lossRecharge.set(lossAcc);
    };
    if (useGw) accumulateGroundwater();
    routeAllMonths();
    if (useGw && aridity) {
        for (let it = 0; it < (H.lossIterations | 0); it++) {
            accumulateGroundwater();    // uses the losses of the previous surface pass
            routeAllMonths();           // baseflow changed -> discharge and losses change
        }
    }
    // Annual mean, low and high flow, and the month of peak flow.
    const discharge = new Float32Array(N);
    const r_flowMin = new Float32Array(N), r_flowMax = new Float32Array(N);
    const r_peakMonth = new Uint8Array(N);
    for (let r = 0; r < N; r++) {
        let sum = 0, mn = Infinity, mx = -Infinity, pk = 0;
        for (let m = 0; m < NM; m++) {
            const v = dischargeM[m][r];
            sum += v;
            if (v < mn) mn = v;
            if (v > mx) { mx = v; pk = m; }
        }
        discharge[r] = sum / NM; r_flowMin[r] = mn; r_flowMax[r] = mx; r_peakMonth[r] = pk;
    }

    // ── 6. Springs and oases: groundwater is the main water source of the cell ──
    const r_spring = new Uint8Array(N);
    let springCount = 0, oasisCount = 0;
    if (useGw) {
        for (let r = 0; r < N; r++) {
            if (isOcean[r] || r_lake[r]) continue;
            if (r_baseflow[r] >= H.springMinKm2 && qInMean[r] < r_baseflow[r]) {
                if (hasClimate && pMean[r] < H.oasisPrecip) { r_spring[r] = 2; oasisCount++; }
                else { r_spring[r] = 1; springCount++; }
            }
        }
    }

    // ── 7. Rivers: threshold discharge into classes; lakes are drawn as lakes ──
    const T = H.riverThresholdsKm2;
    const r_river = new Uint8Array(N);
    const classCounts = [0, 0, 0, 0, 0];
    let landCells = 0;
    for (let r = 0; r < N; r++) {
        if (isOcean[r]) continue;
        landCells++;
        if (r_lake[r]) continue;
        const q = discharge[r];
        let cls = 0;
        if (q >= T[0]) cls = 1;
        if (q >= T[1]) cls = 2;
        if (q >= T[2]) cls = 3;
        if (q >= T[3]) cls = 4;
        r_river[r] = cls;
        classCounts[cls]++;
    }

    return {
        r_flowTo: flowTo,
        r_discharge: discharge,
        r_river,
        r_lake,
        r_lakeLevel,
        r_recharge,
        r_baseflow,
        r_waterTable,
        r_spring,
        r_ice,
        r_flowMonthly: dischargeM,
        r_snowMonthly: snowM,
        r_flowMin,
        r_flowMax,
        r_peakMonth,
        stats: {
            seasonal,
            landCells,
            cellAreaKm2,
            hasClimate,
            riverCells: classCounts[1] + classCounts[2] + classCounts[3] + classCounts[4],
            classCounts,
            iceCells,
            iceMeltKm2,
            iceCalvedKm2,
            lakeCount,
            lakeCells,
            lakeAreaKm2: lakeCells * cellAreaKm2,
            largestLakeKm2: largestLake * cellAreaKm2,
            depressionCells: candCount,
            groundwater: useGw ? {
                smoothingPasses: gw.passes,
                rechargeKm2: gw.rechargeTotal,
                baseflowKm2: gw.baseflowTotal,
                toSeaKm2: gw.toSea,
                lossKm2: lossTotal,
                lossRechargeKm2: gw.lossRechargeTotal,
                springs: springCount,
                oases: oasisCount,
            } : null,
        },
    };
}

// Cache on curData so the (cheap, main-thread) computation reruns only when the
// elevation, precipitation or geology arrays actually change.
function _elevSignature(a) {
    let h = a.length | 0;
    const step = Math.max(1, (a.length / 4096) | 0);
    for (let i = 0; i < a.length; i += step) h = (h * 31 + ((a[i] * 1e5) | 0)) | 0;
    return h;
}

export function getHydrology(curData) {
    if (!curData || !curData.mesh || !curData.r_elevation) return null;
    const a = curData.r_precip_summer || null;
    const b = curData.r_precip_winter || null;
    const ta = curData.r_temperature_summer || (curData.debugLayers && curData.debugLayers.tempSummer) || null;
    const tb = curData.r_temperature_winter || (curData.debugLayers && curData.debugLayers.tempWinter) || null;
    const dl = curData.debugLayers || null;
    const sig = _elevSignature(curData.r_elevation);
    const c = curData._hydro;
    if (c && c.elev === curData.r_elevation && c.a === a && c.b === b && c.ta === ta && c.tb === tb && c.dl === dl && c.sig === sig) return c.result;
    const result = computeHydrology(curData.mesh, curData.r_elevation, a, b, dl ? {
        tempSummer: ta, tempWinter: tb,
        basinWeight: dl.basinWeight || null,
        cratonWeight: dl.cratonWeight || null,
        foldBeltWeight: dl.foldBeltWeight || null,
    } : undefined);
    curData._hydro = { elev: curData.r_elevation, a, b, ta, tb, dl, sig, result };
    return result;
}

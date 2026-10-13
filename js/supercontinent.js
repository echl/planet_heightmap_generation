// Supercontinent cycle: rigid-body continental drift on the coarse plate mesh.
//
// The normal generator lays the continents out evenly. This module plays plate motion forward from that
// layout: every landmass (a connected group of land plates) is a rigid body that drifts along a great circle
// towards a common attractor (the land's centre of mass), and it stops as soon as it touches another
// landmass. Assembly 0 leaves the layout untouched; as the slider rises the continents converge, collide
// and weld into a supercontinent. Because every state is a prefix of the same simulation, the slider moves
// the continents smoothly and monotonically.
//
// Each drifting landmass also gets an Euler pole and angular velocity (the rotation that carries it
// towards the attractor), which the worker blends into the plate velocities. Convergent motion across the
// contact lines is then picked up by the normal collision model, so the sutures become mountain belts.

const N_STEPS = 48;               // simulation steps for assembly = 1
const SEARCH_MARGIN = 0.02;       // extra angular margin (radians) when gathering cells for the raster
const ARRIVE = 1.0;               // an unobstructed landmass reaches the attractor at this share of the slider
const MOTION_BLEND = 0.75;        // share of a plate's velocity that comes from its landmass's rigid motion

// ── small vector helpers ────────────────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Rotation about a unit axis k by angle a (Rodrigues), as a row-major 3x3.
function rotMatrix(k, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    const [x, y, z] = k;
    return [
        t * x * x + c,     t * x * y - s * z, t * x * z + s * y,
        t * x * y + s * z, t * y * y + c,     t * y * z - s * x,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ];
}
function matMul(A, B) {
    const R = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        R[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    }
    return R;
}
const matVec = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
];
const matT = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

// Nearest-point lookup on the coarse cell centres (uniform 3D bucket grid).
function makeNearest(xyz) {
    const n = xyz.length / 3, G = 16, cs = 2 / G;
    const buckets = new Map();
    const key = (ix, iy, iz) => (ix * G + iy) * G + iz;
    const ci = (v) => Math.max(0, Math.min(G - 1, Math.floor((v + 1) / cs)));
    for (let i = 0; i < n; i++) {
        const k = key(ci(xyz[3 * i]), ci(xyz[3 * i + 1]), ci(xyz[3 * i + 2]));
        let b = buckets.get(k); if (!b) { b = []; buckets.set(k, b); } b.push(i);
    }
    return (px, py, pz) => {
        const bx = ci(px), by = ci(py), bz = ci(pz);
        let best = -1, bd = Infinity;
        for (let r = 1; r <= G; r++) {
            for (let ix = Math.max(0, bx - r); ix <= Math.min(G - 1, bx + r); ix++)
                for (let iy = Math.max(0, by - r); iy <= Math.min(G - 1, by + r); iy++)
                    for (let iz = Math.max(0, bz - r); iz <= Math.min(G - 1, bz + r); iz++) {
                        if (r > 1 && Math.max(Math.abs(ix - bx), Math.abs(iy - by), Math.abs(iz - bz)) < r) continue;   // ring only
                        const b = buckets.get(key(ix, iy, iz)); if (!b) continue;
                        for (const i of b) {
                            const dx = xyz[3 * i] - px, dy = xyz[3 * i + 1] - py, dz = xyz[3 * i + 2] - pz;
                            const d = dx * dx + dy * dy + dz * dz;
                            if (d < bd) { bd = d; best = i; }
                        }
                    }
            // anything outside this ring is at least r*cs away
            if (best >= 0 && bd <= (r * cs) * (r * cs)) break;
        }
        return best;
    };
}

/**
 * @param coarseMesh   coarse mesh (adjOffset / adjList / numRegions)
 * @param xyz          coarse cell centres (unit vectors)
 * @param r_plate      Int32Array, plate id per coarse cell (not modified)
 * @param plateIsOcean Set of ocean plate ids
 * @param assembly     0..1
 * @returns { r_plate, motion, removedPlates, info } or null when nothing moves
 *   motion: { plateId: { pole:[x,y,z], omega } } rigid-body drift of the landmass the plate belongs to
 */
export function assembleSupercontinent(coarseMesh, xyz, r_plate, plateIsOcean, assembly) {
    if (!(assembly > 0)) return null;
    const n = coarseMesh.numRegions;
    const { adjOffset, adjList } = coarseMesh;
    const isLand = (c) => !plateIsOcean.has(r_plate[c]);

    // 1. Landmasses: connected components of land cells
    const comp = new Int32Array(n).fill(-1);
    const members = [];
    for (let s = 0; s < n; s++) {
        if (comp[s] !== -1 || !isLand(s)) continue;
        const id = members.length, list = [s]; comp[s] = id;
        for (let qi = 0; qi < list.length; qi++) {
            const c = list[qi];
            for (let k = adjOffset[c]; k < adjOffset[c + 1]; k++) {
                const nb = adjList[k];
                if (comp[nb] === -1 && isLand(nb)) { comp[nb] = id; list.push(nb); }
            }
        }
        members.push(list);
    }
    const numC = members.length;
    if (numC < 2) return null;                        // a single landmass has nothing to assemble

    // 2. Landmass centroids / extents; the attractor is the land's centre of mass
    const cent = members.map((list) => {
        let x = 0, y = 0, z = 0;
        for (const c of list) { x += xyz[3 * c]; y += xyz[3 * c + 1]; z += xyz[3 * c + 2]; }
        return unit([x, y, z]);
    });
    const radius = members.map((list, c) => {
        let m = 0;
        for (const i of list) m = Math.max(m, Math.acos(Math.max(-1, Math.min(1, dot(cent[c], [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]])))));
        return m;
    });
    const order = Array.from({ length: numC }, (_, c) => c).sort((a, b) => members[b].length - members[a].length);
    let A = [0, 0, 0];
    for (let c = 0; c < numC; c++) for (let k = 0; k < 3; k++) A[k] += cent[c][k] * members[c].length;
    A = norm(A) < 0.25 * members.reduce((s, m) => s + m.length, 0) ? cent[order[0]] : unit(A);

    // 3. Each landmass drifts along the great circle from its centroid to the attractor
    const axis = [], total = [], step = [];
    for (let c = 0; c < numC; c++) {
        let k = cross(cent[c], A);
        const sinA = norm(k);
        const ang = Math.atan2(sinA, dot(cent[c], A));
        k = sinA > 1e-6 ? [k[0] / sinA, k[1] / sinA, k[2] / sinA] : [0, 0, 1];
        axis.push(k); total.push(ang); step.push(ang / N_STEPS);
    }

    const nearest = makeNearest(xyz);
    const owner = new Int32Array(n).fill(-1);
    for (let c = 0; c < numC; c++) for (const i of members[c]) owner[i] = c;
    const R = Array.from({ length: numC }, () => [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const touching = new Uint8Array(numC);            // landmass has met another and stopped

    const conflicts = (c, M) => {
        for (const i of members[c]) {
            const p = matVec(M, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]);
            const j = nearest(p[0], p[1], p[2]);
            const o = owner[j];
            if (o !== -1 && o !== c) return true;
        }
        return false;
    };
    // Re-rasterise landmass c at rotation M onto the coarse cells (inverse mapping, so there are no holes).
    const src = new Int32Array(n).fill(-1);
    const raster = (c, M) => {
        for (const i of members[c]) if (owner[i] === c) owner[i] = -1;
        for (let j = 0; j < n; j++) if (owner[j] === c) owner[j] = -1;
        const Mi = matT(M);
        const cc = matVec(M, cent[c]);
        const cosR = Math.cos(Math.min(Math.PI, radius[c] + SEARCH_MARGIN));
        for (let j = 0; j < n; j++) {
            if (xyz[3 * j] * cc[0] + xyz[3 * j + 1] * cc[1] + xyz[3 * j + 2] * cc[2] < cosR) continue;
            const p = matVec(Mi, [xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]]);
            const i = nearest(p[0], p[1], p[2]);
            if (comp[i] === c && owner[j] === -1) { owner[j] = c; src[j] = i; }
        }
    };

    // 4. Run the simulation up to the requested assembly. Every step a free landmass re-aims at the attractor and
    //    drifts one step; if that is blocked it tries to slide around the obstacle (deflected headings) and only
    //    stops for good once it has failed repeatedly. A landmass that arrives early waits for the others.
    const SPEED = N_STEPS * ARRIVE;
    const steps = assembly * N_STEPS;
    const whole = Math.floor(steps), frac = steps - whole;
    const moved = new Uint8Array(numC), fails = new Int32Array(numC);
    const DEFLECT = [0, 0.7, -0.7, 1.4, -1.4];
    for (let s = 0; s < whole + (frac > 1e-9 ? 1 : 0); s++) {
        const f = s < whole ? 1 : frac;
        for (const c of order) {
            if (touching[c]) continue;
            const cur = matVec(R[c], cent[c]);
            const remain = Math.atan2(norm(cross(cur, A)), dot(cur, A));
            if (remain < 1e-3) continue;
            const ang = Math.min(remain, total[c] / SPEED) * f;
            const k0 = unit(cross(cur, A));
            const k1 = cross(cur, k0);                    // k0 turned 90 degrees about the centroid
            let done = false;
            for (const d of DEFLECT) {
                const k = [0, 1, 2].map((i) => k0[i] * Math.cos(d) + k1[i] * Math.sin(d));
                const Mn = matMul(rotMatrix(k, ang), R[c]);
                const nc = matVec(Mn, cent[c]);
                const rem2 = Math.atan2(norm(cross(nc, A)), dot(nc, A));
                if (d !== 0 && rem2 >= remain - 1e-4) continue;      // a slide must still make progress
                if (conflicts(c, Mn)) continue;
                R[c] = Mn; moved[c] = 1; fails[c] = 0; raster(c, Mn); done = true;
                break;
            }
            if (!done && ++fails[c] >= 3) touching[c] = 1;
        }
    }

    // 5. Final plate map: moved landmasses carry their plates, vacated land is refilled from the ocean plates
    const out = new Int32Array(r_plate);
    for (let c = 0; c < numC; c++) if (moved[c]) {
        for (const i of members[c]) if (owner[i] !== c) out[i] = -2;       // vacated (filled below)
    }
    // cells now covered by a moved landmass take the plate of the source cell
    for (let j = 0; j < n; j++) {
        const o = owner[j];
        if (o !== -1 && moved[o] && src[j] !== -1) out[j] = r_plate[src[j]];
    }
    // vacated cells: flood in from ocean cells that stay ocean
    const queue = [];
    const isVacated = (j) => out[j] === -2;
    for (let j = 0; j < n; j++) {
        if (out[j] === -2) continue;
        for (let k = adjOffset[j]; k < adjOffset[j + 1]; k++) if (isVacated(adjList[k])) { queue.push(j); break; }
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const j = queue[qi];
        for (let k = adjOffset[j]; k < adjOffset[j + 1]; k++) {
            const nb = adjList[k];
            if (out[nb] === -2) {
                // only spread ocean plates into the gap
                out[nb] = plateIsOcean.has(out[j]) ? out[j] : -2;
                if (out[nb] !== -2) queue.push(nb);
            }
        }
    }
    // anything still unfilled (all its neighbours were land): pull from the nearest filled neighbour of any kind
    for (let pass = 0; pass < 6; pass++) {
        let any = false;
        for (let j = 0; j < n; j++) if (out[j] === -2) {
            for (let k = adjOffset[j]; k < adjOffset[j + 1]; k++) { const p = out[adjList[k]]; if (p >= 0) { out[j] = p; any = true; break; } }
        }
        if (!any) break;
    }
    for (let j = 0; j < n; j++) if (out[j] === -2) out[j] = r_plate[j];

    // 6. Rigid-body motion for the plates of every landmass that was free to drift
    const motion = {};
    const omega = 1.2;
    for (let c = 0; c < numC; c++) {
        if (total[c] < 1e-3) continue;
        for (const i of members[c]) { const pid = r_plate[i]; if (!motion[pid]) motion[pid] = { pole: axis[c], omega }; }
    }

    // 7. Plates that no longer own any cell have been overridden (subducted / consumed)
    const alive = new Set();
    for (let j = 0; j < n; j++) alive.add(out[j]);
    const removedPlates = [];
    for (const pid of new Set(r_plate)) if (!alive.has(pid)) removedPlates.push(pid);

    return {
        r_plate: out, motion, removedPlates,
        info: { landmasses: numC, moved: moved.reduce((a, b) => a + b, 0), stopped: touching.reduce((a, b) => a + b, 0) },
    };
}

// Blend each landmass's rigid drift into the plate velocities (angular-velocity vectors blend linearly).
export function applyContinentMotion(plateVec, motion) {
    if (!motion) return;
    for (const pid of Object.keys(motion)) {
        const pv = plateVec[pid]; if (!pv) continue;
        const m = motion[pid];
        const w = [0, 1, 2].map((k) => (1 - MOTION_BLEND) * pv.pole[k] * pv.omega + MOTION_BLEND * m.pole[k] * m.omega);
        const l = norm(w);
        if (l < 1e-9) continue;
        pv.pole = [w[0] / l, w[1] / l, w[2] / l];
        pv.omega = l;
    }
}

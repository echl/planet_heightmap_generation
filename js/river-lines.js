// River ribbons: rivers drawn as thin quads along the hydrology flow links, so a river can
// be much narrower than the ~50 km cells it flows through.
//
// Each ribbon segment joins a cell centre to the centre of the downstream cell (or to the
// shared-edge midpoint when the downstream cell is ocean). Width follows a hydraulic-geometry
// power law, w = k * sqrt(Q), in real kilometres, and is converted to pixels in the vertex
// shader, so rivers grow as you zoom in. Anything narrower than MIN_PX is drawn MIN_PX wide.
//
// Seasons: every ribbon carries its 12 monthly discharges in a float texture. The month is a
// uniform, so scrubbing or animating the month slider never rebuilds geometry and every month is
// effectively precached. The shader interpolates discharge between adjacent months and simply
// does not draw a ribbon whose flow is below the draw threshold: a river that dries up vanishes.
//
// Lakes are still painted as whole cells (see makeWaterTint in planet-mesh.js).

import * as THREE from 'three';
import { state } from './state.js';
import { getHydrology, HYDROLOGY } from './hydrology.js';
import { setSnowMonth } from './snow.js';
import { sunUniforms, shadowUniforms, sun } from './scene.js';
import { reliefDisp } from './relief.js';

const MIN_PX = 1.0;                       // never thinner than this on screen
const EARTH_KM = 6371;
const MAP_SX = 2 / Math.PI;               // map x/y units per radian (must match buildMapMesh)
const LIFT = 0.0012;                      // globe: sit just above the terrain
const MAP_Z = 0.002;

const COL_SMALL = [0.16, 0.40, 0.85];
const COL_BIG = [0.04, 0.17, 0.58];
const NM = 12;
const TEX_W = 2048;

// Uniforms shared by the globe and map ribbons, so changing them needs no rebuild.
const shared = {
    month: { value: 6 },                                        // 0..12, continuous (12 wraps to 0)
    minQ: { value: HYDROLOGY.riverLineMinKm2 },                 // below this a ribbon is not drawn
    qLo: { value: Math.log10(HYDROLOGY.riverLineMinKm2) },
    widthK: { value: HYDROLOGY.riverWidthKmPerSqrtMkm2 },
    colSmall: { value: new THREE.Vector3(...COL_SMALL) },
    colBig: { value: new THREE.Vector3(...COL_BIG) },
};

const VERT = `
attribute vec3 posB;
attribute vec2 corner;      // x: 0 at A, 1 at B;  y: -1 / +1 side
attribute float segId;
uniform highp sampler2D qTex;   // monthly discharge, texel (seg * 12 + month)
uniform float texW;
uniform float month;
uniform float minQ;
uniform float qLo;
uniform float widthK;
uniform vec3 colSmall;
uniform vec3 colBig;
uniform vec2 viewport;      // CSS pixels
uniform float unitsPerKm;
uniform float minPx;
uniform float depthBias;     // world units toward the camera (globe); 0 on the map
varying vec3 vColor;
varying float vWx;
varying vec3 vN;            // world-space surface normal (globe: radial)
varying vec3 vWp;           // world position (for the shadow lookup)
uniform float lit;
float qAt(float seg, int m) {
    int idx = int(seg) * 12 + m;
    int w = int(texW);
    return texelFetch(qTex, ivec2(idx % w, idx / w), 0).r;
}
void main() {
    float m0f = floor(month);
    float fr = month - m0f;
    int m0 = int(mod(m0f, 12.0));
    int m1 = (m0 + 1) % 12;
    float Q = mix(qAt(segId, m0), qAt(segId, m1), fr);
    if (Q < minQ) {                      // dry (or below the stream cut-off): draw nothing
        vColor = vec3(0.0); vWx = 0.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    float widthKm = widthK * sqrt(Q / 1.0e6);
    float f = clamp((log(Q) / 2.302585 - qLo) / (7.0 - qLo), 0.0, 1.0);
    vColor = mix(colSmall, colBig, f);
    // Nudge toward the camera in view space (a distance, not a depth-buffer fraction), so the ribbon
    // clears the terrain triangles under it but is still hidden by mountains in front of it.
    vec4 mvA = modelViewMatrix * vec4(position, 1.0); mvA.z += depthBias;
    vec4 mvB = modelViewMatrix * vec4(posB, 1.0);     mvB.z += depthBias;
    vec4 cA = projectionMatrix * mvA;
    vec4 cB = projectionMatrix * mvB;
    vN = lit > 0.5 ? normalize(mat3(modelMatrix) * normalize(mix(position, posB, corner.x))) : vec3(0.0);
    vec2 sA = cA.xy / cA.w * viewport * 0.5;
    vec2 sB = cB.xy / cB.w * viewport * 0.5;
    vec2 d = sB - sA;
    float len = length(d);
    d = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    vec4 c = mix(cA, cB, corner.x);
    // Pixels per world unit at this depth (works for the perspective and orthographic cameras).
    float pxPerUnit = projectionMatrix[1][1] * viewport.y * 0.5 / c.w;
    float halfPx = max(0.5 * minPx, 0.5 * widthKm * unitsPerKm * pxPerUnit);
    vec2 off = n * corner.y * halfPx + d * (corner.x * 2.0 - 1.0) * halfPx;   // square caps close the joints
    c.xy += off / (viewport * 0.5) * c.w;
    vec4 wp = modelMatrix * vec4(mix(position, posB, corner.x), 1.0);
    vWx = wp.x; vWp = wp.xyz;
    gl_Position = c;
}`;

const FRAG = `
uniform float clipX;
uniform vec3 sunDir;
uniform vec3 sunRGB;
uniform vec3 ambRGB;
uniform float dayOnly;
uniform float lit;
varying vec3 vColor;
varying float vWx;
varying vec3 vN;
varying vec3 vWp;
uniform sampler2D shadowMap;
uniform mat4 shadowMat;
uniform float shadowOn;
#include <packing>
void main() {
    if (clipX > 0.0 && abs(vWx) > clipX) discard;
    vec3 col = vColor;
    if (lit > 0.5 && dayOnly > 0.5) {                          // Realistic mode only; otherwise the original flat colour
        float d = max(dot(normalize(vN), sunDir), 0.0);
        if (shadowOn > 0.5) {                                   // same shadow map as the terrain
            vec4 sc = shadowMat * vec4(vWp, 1.0);
            sc.xyz /= sc.w;
            if (sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0) {
                float depth = unpackRGBAToDepth(texture2D(shadowMap, sc.xy));
                d *= (sc.z - 0.00006 <= depth) ? 1.0 : 0.0;
            }
        }
        col *= (ambRGB + sunRGB * d) / 3.14159265;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
}`;

function makeMaterial(unitsPerKm, depthBias, clipX, qTex, lit) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...shared,
            qTex: { value: qTex },
            texW: { value: TEX_W },
            viewport: { value: new THREE.Vector2(1, 1) },
            unitsPerKm: { value: unitsPerKm },
            minPx: { value: MIN_PX },
            depthBias: { value: depthBias },
            clipX: { value: clipX },
            lit: { value: lit ? 1 : 0 },
            ...sunUniforms,
            ...shadowUniforms,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        depthWrite: false,
        side: THREE.DoubleSide,           // the screen-space quad winding is not preserved by the projection
    });
}

// segs: { pa:number[], pb:number[], q:number[] (12 per segment) } one entry per link
function makeQTexture(q) {
    const n = q.length;
    const rows = Math.max(1, Math.ceil(n / TEX_W));
    const data = new Float32Array(TEX_W * rows);
    data.set(q);
    const tex = new THREE.DataTexture(data, TEX_W, rows, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
}

function makeRibbonMesh(segs, makeMat) {
    const k = segs.pa.length / 3;
    const pos = new Float32Array(k * 12), posB = new Float32Array(k * 12);
    const corner = new Float32Array(k * 8), sid = new Float32Array(k * 4);
    const idx = new Uint32Array(k * 6);
    const CX = [0, 0, 1, 1], CY = [-1, 1, -1, 1];
    for (let i = 0; i < k; i++) {
        for (let v = 0; v < 4; v++) {
            const o = i * 4 + v;
            for (let a = 0; a < 3; a++) {
                pos[3 * o + a] = segs.pa[3 * i + a];
                posB[3 * o + a] = segs.pb[3 * i + a];
            }
            corner[2 * o] = CX[v]; corner[2 * o + 1] = CY[v];
            sid[o] = i;
        }
        const b = i * 4;
        idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('posB', new THREE.BufferAttribute(posB, 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('segId', new THREE.BufferAttribute(sid, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const tex = makeQTexture(segs.q);
    const material = makeMat(tex);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;       // the true extent depends on the screen-space offset
    mesh.raycast = () => {};          // never intercept hover picking
    mesh.renderOrder = 2;
    const v2 = new THREE.Vector2();
    mesh.onBeforeRender = (r) => {
        r.getSize(v2); material.uniforms.viewport.value.copy(v2);
        if (sun.shadow.map) shadowUniforms.shadowMap.value = sun.shadow.map.texture;   // exists once the first shadow pass ran
    };
    return mesh;
}

// Collect the drawable flow links: any link that carries at least riverLineMinKm2 in some month.
// Whether it is drawn at a given moment is decided in the shader from the month and the
// Small Streams setting, so intermittent rivers appear and disappear without a rebuild.
function collectLinks(curData, h) {
    const { mesh, r_elevation } = curData;
    const N = mesh.numRegions;
    const minQ = HYDROLOGY.riverLineMinKm2;
    const links = [];
    for (let r = 0; r < N; r++) {
        if (r_elevation[r] <= 0) continue;
        if (!(h.r_flowMax[r] >= minQ)) continue;
        const t = h.r_flowTo[r];
        if (t < 0) continue;
        if (h.r_lake[r] && h.r_lake[t]) continue;           // inside a lake: the filled cells show it
        const q = new Float32Array(NM);
        for (let m = 0; m < NM; m++) q[m] = h.r_flowMonthly[m][r];
        links.push({ r, t, land: r_elevation[t] > 0, q });
    }
    return links;
}

function endpointDir(curData, link) {
    // Unit vector of the far end: the downstream cell centre, or the midpoint to an ocean cell.
    const x = curData.r_xyz;
    const r = link.r, t = link.t;
    if (link.land) return [x[3 * t], x[3 * t + 1], x[3 * t + 2]];
    const mx = x[3 * r] + x[3 * t], my = x[3 * r + 1] + x[3 * t + 1], mz = x[3 * r + 2] + x[3 * t + 2];
    const l = Math.hypot(mx, my, mz) || 1;
    return [mx / l, my / l, mz / l];
}

function disp(e) { return reliefDisp(e, LIFT); }

function disposePart(key) {
    const m = state[key];
    if (!m) return;
    m.removeFromParent();
    m.traverse(o => { if (o.geometry && o === m) o.geometry.dispose(); });
    if (m.material) {
        if (m.material.uniforms && m.material.uniforms.qTex.value) m.material.uniforms.qTex.value.dispose();
        m.material.dispose();
    }
    state[key] = null;
}

export function riverLinesWanted() {
    if (!state.showWater || !state.curData) return false;
    const plates = document.getElementById('chkPlates');
    const dl = state.debugLayer || '';
    return !(plates && plates.checked) && (!dl || dl === 'biome');
}

export function buildGlobeRivers() {
    disposePart('riverGlobeMesh');
    if (!state.curData || !state.planetMesh) return;
    const h = getHydrology(state.curData);
    if (!h) return;
    const links = collectLinks(state.curData, h);
    state._riverGlobeSrc = h;
    if (!links.length) return;
    const { r_xyz, r_elevation } = state.curData;
    const segs = { pa: [], pb: [], q: new Float32Array(links.length * NM) };
    links.forEach((L, i) => {
        const dA = disp(r_elevation[L.r]);
        const dB = L.land ? disp(r_elevation[L.t]) : dA;
        const e = endpointDir(state.curData, L);
        segs.pa.push(r_xyz[3 * L.r] * dA, r_xyz[3 * L.r + 1] * dA, r_xyz[3 * L.r + 2] * dA);
        segs.pb.push(e[0] * dB, e[1] * dB, e[2] * dB);
        segs.q.set(L.q, i * NM);
    });
    const mesh = makeRibbonMesh(segs, (tex) => makeMaterial(1 / EARTH_KM, state.realisticRelief ? 0.0006 : 0.006, 0, tex, true));
    mesh.visible = riverLinesWanted();
    state.planetMesh.add(mesh);          // child of the planet, so it follows auto-rotation
    state.riverGlobeMesh = mesh;
}

export function buildMapRivers() {
    disposePart('riverMapMesh');
    if (!state.curData || !state.mapMesh) return;
    const h = getHydrology(state.curData);
    if (!h) return;
    const links = collectLinks(state.curData, h);
    state._riverMapSrc = h;
    if (!links.length) return;
    const { r_xyz } = state.curData;
    const PI = Math.PI, centerLon = state.mapCenterLon || 0;
    const wrapLon = (lon) => { let l = lon - centerLon; if (l > PI) l -= 2 * PI; else if (l < -PI) l += 2 * PI; return l; };
    const proj = (x, y, z) => [wrapLon(Math.atan2(x, z)) * MAP_SX, Math.asin(Math.max(-1, Math.min(1, y))) * MAP_SX];
    const segs = { pa: [], pb: [], q: [] };
    const qs = [];
    const push = (ax, ay, bx, by, L) => { segs.pa.push(ax, ay, MAP_Z); segs.pb.push(bx, by, MAP_Z); qs.push(L.q); };
    for (const L of links) {
        const [ax, ay] = proj(r_xyz[3 * L.r], r_xyz[3 * L.r + 1], r_xyz[3 * L.r + 2]);
        const e = endpointDir(state.curData, L);
        const [bx, by] = proj(e[0], e[1], e[2]);
        if (Math.abs(ax - bx) > 2) {     // crosses the map seam: emit both halves
            const [lx, ly, rx, ry] = ax < bx ? [ax, ay, bx, by] : [bx, by, ax, ay];   // left end, right end
            if (ax < bx) { push(lx, ly, rx - 4, ry, L); push(lx + 4, ly, rx, ry, L); }
            else { push(rx - 4, ry, lx, ly, L); push(rx, ry, lx + 4, ly, L); }
        } else {
            push(ax, ay, bx, by, L);
        }
    }
    segs.q = new Float32Array(qs.length * NM);
    qs.forEach((q, i) => segs.q.set(q, i * NM));
    // Map x units per km along the equator (x spans 4 units over 2*pi*R km).
    const mesh = makeRibbonMesh(segs, (tex) => makeMaterial(MAP_SX / EARTH_KM, 0, 2, tex, false));
    mesh.visible = riverLinesWanted();
    const mat = mesh.material;
    // Wrap clones for smooth longitude scrolling (the parent's translation applies too).
    const grp = new THREE.Group();
    grp.add(mesh);
    const cL = new THREE.Mesh(mesh.geometry, mat), cR = new THREE.Mesh(mesh.geometry, mat);
    for (const [c, x] of [[cL, -4], [cR, 4]]) {
        c.position.x = x; c.frustumCulled = false; c.raycast = () => {}; c.renderOrder = 2;
        c.onBeforeRender = mesh.onBeforeRender;
        grp.add(c);
    }
    grp.visible = riverLinesWanted();
    grp.geometry = mesh.geometry; grp.material = mat;       // so disposePart can free them
    state.mapMesh.add(grp);
    state.riverMapMesh = grp;
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Move the season clock. `month` is continuous in [0, 12); the ribbons interpolate between months.
export function setRiverMonth(month) {
    const m = ((month % NM) + NM) % NM;
    state.seasonMonth = m;
    shared.month.value = m;
    setSnowMonth(m);
}

// Show/hide to match the current layer settings and rebuild if the hydrology changed.
export function refreshRiverLines() {
    if (!state.curData) return;
    const h = getHydrology(state.curData);
    if (state.planetMesh && (state._riverGlobeSrc !== h || !state.riverGlobeMesh || state.riverGlobeMesh.parent !== state.planetMesh)) buildGlobeRivers();
    if (state.mapMesh && (state._riverMapSrc !== h || !state.riverMapMesh || state.riverMapMesh.parent !== state.mapMesh)) buildMapRivers();
    // Small Streams only moves the draw threshold, so it needs no rebuild.
    shared.minQ.value = state.showStreams ? HYDROLOGY.riverLineMinKm2 : HYDROLOGY.riverThresholdsKm2[0];
    shared.month.value = state.seasonMonth == null ? 6 : state.seasonMonth;
    const on = riverLinesWanted();
    if (state.riverGlobeMesh) state.riverGlobeMesh.visible = on;
    if (state.riverMapMesh) state.riverMapMesh.visible = on;
    const seasonal = !!(h && h.stats.seasonal);
    for (const id of ['sMonth', 'chkSeasonPlay']) { const el = document.getElementById(id); if (el) el.disabled = !seasonal; }
}

// Seasonal snow (and sea ice) for the Satellite view.
//
// The hydrology model keeps a monthly snowpack per cell (rain/snow split at 0 C, degree-day melt),
// so snow cover follows temperature (latitude, altitude, season) and precipitation (dry cold
// ground gets little snow). Here that depth becomes a cover fraction 0..1, 1 - exp(-depth/S0),
// a little thinner under forest, and on the ocean a freeze fraction from the sea-surface
// temperature. All 12 months go into one byte texture indexed by (region * 12 + month); the
// terrain shaders look it up per vertex, so scrubbing or animating the month recolours the whole
// planet by moving one uniform: nothing is rebuilt.

import * as THREE from 'three';
import { state } from './state.js';
import { getHydrology, HYDROLOGY } from './hydrology.js';
import { realUniforms } from './realistic.js';

const NM = 12;
const TEX_W = 4096;
const S0 = 0.015;                 // snow water-equivalent that gives ~63% cover (precipitation units, ~15 mm)
const FOREST_FACTOR = 0.85;       // trees show through: less than full cover under forest
const SEA_FREEZE_C = -1.8;        // sea ice starts to form here and is complete 2 C colder
// Koppen ids that are forested (see BIOME_COLORS in color-map.js).
const FOREST = new Set([1, 2, 8, 9, 10, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28]);

const dummy = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
dummy.needsUpdate = true;

export const snowUniforms = {
    snowTex: { value: dummy },
    snowTexW: { value: 1 },
    snowMonth: { value: 6 },
    snowOn: { value: 0 },
    snowRagged: realUniforms.realFx,      // Realistic mode: ragged, noise-broken snow edges (done in the fragment shader)
};

let _cache = null;     // { key..., tex }

function buildTexture(curData, h, smooth) {
    const mesh = curData.mesh, N = mesh.numRegions, e = curData.r_elevation;
    const koppen = (curData.debugLayers && curData.debugLayers.koppen) || null;
    const ta = curData.r_temperature_summer || null, tb = curData.r_temperature_winter || null;
    const snow = h.r_snowMonthly;
    const rows = Math.ceil(N * NM / TEX_W);
    const data = new Uint8Array(TEX_W * rows);
    const wS = new Float32Array(NM);
    for (let m = 0; m < NM; m++) wS[m] = 0.5 * (1 + Math.cos(2 * Math.PI * (m - HYDROLOGY.summerMonth) / NM));
    for (let r = 0; r < N; r++) {
        const o = r * NM;
        if (e[r] > 0) {
            const f = (koppen && FOREST.has(koppen[r])) ? FOREST_FACTOR : 1;
            for (let m = 0; m < NM; m++) {
                const c = (1 - Math.exp(-snow[m][r] / S0)) * f;
                data[o + m] = Math.round(255 * (c > 1 ? 1 : c));
            }
        } else if (ta && tb) {
            const Ts = -45 + 90 * ta[r], Tw = -45 + 90 * tb[r];
            for (let m = 0; m < NM; m++) {
                const T = wS[m] * Ts + (1 - wS[m]) * Tw;
                let c = (SEA_FREEZE_C - T) / 2;
                c = c < 0 ? 0 : (c > 1 ? 1 : c);
                data[o + m] = Math.round(255 * c);
            }
        }
    }
    if (smooth) {   // Realistic mode: bleed cover into neighbouring cells so the shader can rag the edge with noise
        const src = data.slice(), { adjOffset, adjList } = mesh;
        for (let r = 0; r < N; r++) {
            const a = adjOffset[r], b = adjOffset[r + 1];
            if (b === a) continue;
            for (let m = 0; m < NM; m++) {
                let sum = 0;
                for (let i = a; i < b; i++) sum += src[adjList[i] * NM + m];
                data[r * NM + m] = Math.round(0.5 * src[r * NM + m] + 0.5 * sum / (b - a));
            }
        }
    }
    const tex = new THREE.DataTexture(data, TEX_W, rows, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
}

export function setSnowMonth(m) { snowUniforms.snowMonth.value = m; }

// Snow shows in the Satellite view only (the biome layer), when Seasonal Snow is on.
export function refreshSnow() {
    const cd = state.curData;
    let on = !!(cd && state.showSnow !== false && state.debugLayer === 'biome');
    if (on) {
        const h = getHydrology(cd);
        if (!h || !h.r_snowMonthly) on = false;
        else {
            const koppen = cd.debugLayers && cd.debugLayers.koppen, ta = cd.r_temperature_summer, tb = cd.r_temperature_winter;
            if (!_cache || _cache.h !== h || _cache.koppen !== koppen || _cache.ta !== ta || _cache.tb !== tb || _cache.e !== cd.r_elevation || _cache.smooth !== !!state.realisticRelief) {
                if (_cache && _cache.tex) _cache.tex.dispose();
                _cache = { h, koppen, ta, tb, e: cd.r_elevation, smooth: !!state.realisticRelief, tex: buildTexture(cd, h, !!state.realisticRelief) };
            }
            snowUniforms.snowTex.value = _cache.tex;
            snowUniforms.snowTexW.value = TEX_W;
        }
    }
    snowUniforms.snowOn.value = on ? 1 : 0;
    snowUniforms.snowMonth.value = state.seasonMonth == null ? 6 : state.seasonMonth;
}

// Patch a vertex-coloured terrain material so cells fade towards snow white by the cover texture.
// The geometry needs a per-vertex `regionId` attribute.
export function applySnowShader(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
        if (prev) prev(shader, renderer);
        Object.assign(shader.uniforms, snowUniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
attribute float regionId;
uniform highp sampler2D snowTex;
uniform float snowTexW;
uniform float snowMonth;
uniform float snowOn;
uniform float snowRagged;
varying float vSnow;
float snowAt(int r, int m) {
    int idx = r * 12 + m;
    int w = int(snowTexW);
    return texelFetch(snowTex, ivec2(idx % w, idx / w), 0).r;
}`)
            .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
if (snowOn > 0.5) {
    float m0f = floor(snowMonth);
    float fr = snowMonth - m0f;
    int m0 = int(mod(m0f, 12.0));
    int m1 = (m0 + 1) % 12;
    float cover = mix(snowAt(int(regionId), m0), snowAt(int(regionId), m1), fr);
    if (snowRagged > 0.5) vSnow = cover; else vColor = mix(vColor, vec3(0.92, 0.95, 0.99), cover * 0.95);
} else vSnow = 0.0;
#endif`);
    };
    const type = mat.type;
    mat.customProgramCacheKey = () => 'snow1-' + type;
    mat.needsUpdate = true;
}

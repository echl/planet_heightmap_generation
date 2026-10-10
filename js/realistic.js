// Extra realism for the Satellite view's Realistic mode: procedural ground detail (albedo
// variation, micro-relief normal bump, cloud shadows), a clear reflective sea, and a seasonal
// cloud layer whose coverage follows the model's precipitation. Everything is gated by
// `realUniforms.realFx` (0 = off), so the normal views are untouched.

import * as THREE from 'three';
import { state } from './state.js';
import { scene, sunUniforms } from './scene.js';
import { HYDROLOGY } from './hydrology.js';

const R_KM = 6371;
const CLOUD_R = 1.0016;          // cloud shell radius (a few km up)

const dummyTex = new THREE.DataTexture(new Uint8Array([0, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
dummyTex.needsUpdate = true;

export const realUniforms = {
    realFx: { value: 0 },
    sunObj: { value: new THREE.Vector3(1, 0, 0) },
    cloudTex: { value: dummyTex },
    cloudSeason: { value: 0.5 },     // 1 = northern-summer precipitation, 0 = winter
    cloudDrift: { value: 0 },
};

const NOISE_GLSL = `
uint ihash(uvec3 p) {
    p *= uvec3(1597334673u, 3812015801u, 2798796415u);
    uint h = (p.x ^ p.y ^ p.z) * 1597334673u;
    h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
    return h;
}
float h3(ivec3 i) { return float(ihash(uvec3(i))) * (1.0 / 4294967295.0); }
float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    ivec3 b = ivec3(i);
    return mix(mix(mix(h3(b), h3(b + ivec3(1,0,0)), f.x), mix(h3(b + ivec3(0,1,0)), h3(b + ivec3(1,1,0)), f.x), f.y),
               mix(mix(h3(b + ivec3(0,0,1)), h3(b + ivec3(1,0,1)), f.x), mix(h3(b + ivec3(0,1,1)), h3(b + ivec3(1,1,1)), f.x), f.y), f.z);
}
`;

const CLOUD_GLSL = `
uniform sampler2D cloudTex;
uniform float cloudSeason;
uniform float cloudDrift;
float cloudDensity(vec3 d) {
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    vec2 pc = texture2D(cloudTex, uv).rg;
    float cov = clamp(0.02 + 0.5 * mix(pc.g, pc.r, cloudSeason), 0.0, 0.6);
    float ca = cos(cloudDrift), sa = sin(cloudDrift);
    vec3 q = vec3(ca * d.x + sa * d.z, d.y, -sa * d.x + ca * d.z);
    vec3 w = vec3(vnoise(q * 3.0), vnoise(q * 3.0 + 7.3), vnoise(q * 3.0 + 3.1)) - 0.5;
    q = q * 5.0 + w * 1.3;
    float n = 0.50 * vnoise(q) + 0.25 * vnoise(q * 2.1) + 0.125 * vnoise(q * 4.3)
            + 0.0625 * vnoise(q * 8.7) + 0.03 * vnoise(q * 17.0);
    n /= 0.9675;
    float th = 0.68 - 0.40 * cov;
    return smoothstep(th, th + 0.18, n);
}
`;

// ── Terrain ──────────────────────────────────────────────────────────────────────────────
export function applyRealisticTerrain(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
        if (prev) prev(shader, renderer);
        Object.assign(shader.uniforms, realUniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
varying vec3 vOP; varying float vHk; varying vec3 vNX; varying vec3 vNY; varying vec3 vNZ;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vOP = position; vHk = (length(position) - 1.0) * ${R_KM}.0;
vNX = normalMatrix * vec3(1.0, 0.0, 0.0); vNY = normalMatrix * vec3(0.0, 1.0, 0.0); vNZ = normalMatrix * vec3(0.0, 0.0, 1.0);`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
varying vec3 vOP; varying float vHk; varying vec3 vNX; varying vec3 vNY; varying vec3 vNZ;
varying float vSnow;
uniform float realFx; uniform vec3 sunObj;
${NOISE_GLSL}${CLOUD_GLSL}
float lodw(float f, float fw) { return 1.0 - smoothstep(0.2, 0.7, f * fw); }
float microH(vec3 p, float fw) {
    return 0.55 * vnoise(p * 140.0) * lodw(140.0, fw) + 0.30 * vnoise(p * 480.0) * lodw(480.0, fw)
         + 0.15 * vnoise(p * 1600.0) * lodw(1600.0, fw);
}`)
            .replace('#include <color_fragment>', `#include <color_fragment>
if (realFx > 0.5) {
    float fw = length(fwidth(vOP));
    float n = 0.45 * vnoise(vOP * 60.0) + 0.30 * vnoise(vOP * 210.0) * lodw(210.0, fw)
            + 0.15 * vnoise(vOP * 760.0) * lodw(760.0, fw) + 0.10 * vnoise(vOP * 2600.0) * lodw(2600.0, fw);
    float lw = 0.45 + 0.30 * lodw(210.0, fw) + 0.15 * lodw(760.0, fw) + 0.10 * lodw(2600.0, fw);
    n = n / lw - 0.5;
    float land = smoothstep(-0.02, 0.05, vHk);
    float amp = mix(0.10, 0.34, land);
    diffuseColor.rgb *= 1.0 + amp * n;
    float tint = vnoise(vOP * 30.0) - 0.5;
    diffuseColor.rgb *= vec3(1.0 + 0.10 * tint, 1.0 + 0.04 * tint, 1.0 - 0.10 * tint) * land + vec3(1.0) * (1.0 - land);
    // cloud shadows on the ground (the sun's ray up to the cloud shell)
    if (vSnow > 0.02) {   // ragged snow edge: the cell's cover against fractal noise
        float sn = vSnow * 0.95;
        float nz = 0.55 * vnoise(vOP * 90.0) + 0.30 * vnoise(vOP * 330.0) * lodw(330.0, fw) + 0.15 * vnoise(vOP * 1200.0) * lodw(1200.0, fw);
        nz /= 0.55 + 0.30 * lodw(330.0, fw) + 0.15 * lodw(1200.0, fw);
        float cv = smoothstep(0.38, 0.62, sn * 1.25 + (nz - 0.5) * 0.9) * smoothstep(0.0, 0.1, sn);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.99), cv);
    }
    vec3 nO = normalize(vOP);
    float mu = dot(nO, sunObj);
    if (mu > 0.0) {
        float cd = cloudDensity(normalize(vOP + sunObj * (${(CLOUD_R - 1).toFixed(4)} / max(mu, 0.15))));
        diffuseColor.rgb *= 1.0 - 0.55 * cd;
    }
}`)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (realFx > 0.5) {
    float fw2 = length(fwidth(vOP));
    float e = 0.0004;
    float b0 = microH(vOP, fw2);
    vec3 g = vec3(microH(vOP + vec3(e, 0.0, 0.0), fw2) - b0, microH(vOP + vec3(0.0, e, 0.0), fw2) - b0,
                  microH(vOP + vec3(0.0, 0.0, e), fw2) - b0) / e;
    vec3 nO2 = normalize(vOP);
    g -= dot(g, nO2) * nO2;
    float hk = max(vHk, 0.0);
    float A = 0.00035 * (0.35 + 1.4 * min(hk / 3.0, 1.0)) * smoothstep(-0.02, 0.05, vHk);
    vec3 gv = g.x * vNX + g.y * vNY + g.z * vNZ;
    normal = normalize(normal - A * gv);
}`);
    };
    const type = mat.type, oldKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => oldKey.call(mat) + '+real2-' + type;
    mat.needsUpdate = true;
}

// ── Sea ──────────────────────────────────────────────────────────────────────────────────
// Clearer water (the depth-coloured sea floor shows through) plus a Fresnel sky reflection.
// No sun glint: only the diffuse sky colour is reflected.
export function applyRealisticOcean(mat) {
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.realFx = realUniforms.realFx;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float realFx;')
            .replace('#include <opaque_fragment>', `
if (realFx > 0.5) {
    vec3 Nw = normalize(vNormal);
    float c = clamp(dot(Nw, normalize(vViewPosition)), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
    #if NUM_DIR_LIGHTS > 0
    float dayN = smoothstep(-0.12, 0.35, dot(Nw, directionalLights[0].direction));
    #else
    float dayN = 1.0;
    #endif
    outgoingLight += vec3(0.32, 0.52, 0.85) * F * dayN * 0.9;
    diffuseColor.a = mix(diffuseColor.a, 1.0, F);
}
#include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'ocean-real1';
    mat.needsUpdate = true;
}

// ── Clouds ───────────────────────────────────────────────────────────────────────────────
let cloudMesh = null, _cloudKey = null;

function buildCloudTexture(cd) {
    const W = 720, H = 360, mesh = cd.mesh, N = mesh.numRegions, xyz = cd.r_xyz;
    const ps = cd.r_precip_summer, pw = cd.r_precip_winter;
    if (!ps || !pw) return null;
    const BW = 180, BH = 90, bins = Array.from({ length: BW * BH }, () => []);
    const lonOf = (x, z) => Math.atan2(z, x), latOf = (y) => Math.asin(Math.max(-1, Math.min(1, y)));
    for (let r = 0; r < N; r++) {
        const lon = lonOf(xyz[3*r], xyz[3*r+2]), lat = latOf(xyz[3*r+1]);
        const bx = Math.min(BW - 1, Math.floor((lon / (2 * Math.PI) + 0.5) * BW));
        const by = Math.min(BH - 1, Math.floor((lat / Math.PI + 0.5) * BH));
        bins[by * BW + bx].push(r);
    }
    const data = new Uint8Array(W * H * 2);
    for (let j = 0; j < H; j++) {
        const lat = ((j + 0.5) / H - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
        const by = Math.min(BH - 1, Math.floor(((j + 0.5) / H) * BH));
        const dl = Math.min(BW >> 1, Math.ceil(1.5 / Math.max(cl, 0.02)));
        for (let i = 0; i < W; i++) {
            const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
            const px = cl * Math.cos(lon), pz = cl * Math.sin(lon);
            const bx = Math.min(BW - 1, Math.floor(((i + 0.5) / W) * BW));
            let best = -1, bd = -2;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = by + dy; if (yy < 0 || yy >= BH) continue;
                for (let dx = -dl; dx <= dl; dx++) {
                    const list = bins[yy * BW + ((bx + dx) % BW + BW) % BW];
                    for (let k = 0; k < list.length; k++) {
                        const r = list[k];
                        const d = xyz[3*r] * px + xyz[3*r+1] * sl + xyz[3*r+2] * pz;
                        if (d > bd) { bd = d; best = r; }
                    }
                }
            }
            const o = (j * W + i) * 2;
            if (best >= 0) {
                data[o] = Math.max(0, Math.min(255, Math.round(255 * ps[best])));
                data[o + 1] = Math.max(0, Math.min(255, Math.round(255 * pw[best])));
            }
        }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function ensureCloudMesh() {
    if (cloudMesh) return cloudMesh;
    const mat = new THREE.ShaderMaterial({
        uniforms: { ...realUniforms, sunDir: sunUniforms.sunDir, dayOnly: sunUniforms.dayOnly },
        transparent: true, depthWrite: false,
        vertexShader: `varying vec3 vOP; varying vec3 vWN;
void main() { vOP = position; vWN = normalize(mat3(modelMatrix) * position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying vec3 vOP; varying vec3 vWN; uniform vec3 sunDir; uniform float dayOnly;
${NOISE_GLSL}${CLOUD_GLSL}
void main() {
    float d = cloudDensity(normalize(vOP));
    if (d < 0.003) discard;
    float ndl = dot(normalize(vWN), normalize(sunDir));
    float lit = smoothstep(-0.10, 0.30, ndl) * (0.30 + 0.70 * clamp(ndl * 1.4, 0.0, 1.0));
    float twi = smoothstep(0.0, 0.25, ndl) * (1.0 - smoothstep(0.25, 0.6, ndl));
    vec3 col = vec3(0.96, 0.97, 1.0) * lit;
    col = mix(col, col * vec3(1.0, 0.72, 0.52), twi * 0.5);
    col += vec3(0.004, 0.006, 0.010);
    gl_FragColor = vec4(col, d * 0.88);
    #include <colorspace_fragment>
}`,
    });
    cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_R, 128, 96), mat);
    cloudMesh.renderOrder = -1;
    cloudMesh.visible = false;
    scene.add(cloudMesh);
    return cloudMesh;
}

// Called every frame (cheap): keeps the cloud layer, sun direction and seasonal weights current.
export function tickRealistic() {
    const on = !!(state.realisticRelief && !state.mapMode && state.planetMesh && state.curData);
    realUniforms.realFx.value = on ? 1 : 0;
    if (!on) { if (cloudMesh) cloudMesh.visible = false; return; }
    const cd = state.curData;
    if (_cloudKey !== cd.r_precip_summer) {
        const t = buildCloudTexture(cd);
        if (t) { if (realUniforms.cloudTex.value !== dummyTex) realUniforms.cloudTex.value.dispose(); realUniforms.cloudTex.value = t; }
        _cloudKey = cd.r_precip_summer;
    }
    const cm = ensureCloudMesh();
    cm.visible = true;
    const th = state.planetMesh.rotation.y;
    cm.rotation.y = th;
    const m = state.seasonMonth == null ? 6 : state.seasonMonth;
    realUniforms.cloudSeason.value = 0.5 * (1 + Math.cos(2 * Math.PI * (m - HYDROLOGY.summerMonth) / 12));
    realUniforms.cloudDrift.value = performance.now() * 1e-3 * 2e-4;
    const s = sunUniforms.sunDir.value, c = Math.cos(th), sn = Math.sin(th);
    realUniforms.sunObj.value.set(s.x * c - s.z * sn, s.y, s.x * sn + s.z * c).normalize();
}

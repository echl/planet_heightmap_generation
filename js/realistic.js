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

const dummyWind = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
dummyWind.needsUpdate = true;

export const realUniforms = {
    realFx: { value: 0 },
    sunObj: { value: new THREE.Vector3(1, 0, 0) },
    cloudTex: { value: dummyTex },
    cloudSeason: { value: 0.5 },     // 1 = northern-summer precipitation, 0 = winter
    cloudDrift: { value: 0 },
    cloudEvo: { value: 0 },
    cloudWindTex: { value: dummyWind },   // RGBA8: summer E,N then winter E,N wind (speed-scaled unit vectors, 0.5 = calm)
    cloudWindOn: { value: 0 },          // time offset that makes the cloud shapes evolve (octaves slide at different speeds)
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
uniform float cloudEvo;
uniform sampler2D cloudWindTex;
uniform float cloudWindOn;
// Cloud pattern at direction d, with the noise domain turned about the pole by angle a (moves the pattern east/west).
float cloudField(vec3 d, float a) {
    float ca = cos(a), sa = sin(a);
    vec3 q = vec3(ca * d.x + sa * d.z, d.y, -sa * d.x + ca * d.z);
    vec3 ev = vec3(cloudEvo);
    vec3 w = vec3(vnoise(q * 3.0 + ev * vec3(0.6, 0.2, 0.4)), vnoise(q * 3.0 + 7.3 + ev * vec3(0.3, 0.7, 0.1)), vnoise(q * 3.0 + 3.1 + ev * vec3(0.2, 0.4, 0.8))) - 0.5;
    q = q * 5.0 + w * 1.3;
    float n = 0.50 * vnoise(q + ev * vec3(0.5, 0.0, 0.3)) + 0.25 * vnoise(q * 2.1 + ev * vec3(0.0, 0.9, 0.4))
            + 0.125 * vnoise(q * 4.3 + ev * vec3(0.8, 0.3, 0.0)) + 0.0625 * vnoise(q * 8.7 + ev * vec3(0.0, 0.5, 1.2)) + 0.03 * vnoise(q * 17.0);
    return n / 0.9675;
}
// cloudDrift is the wind clock. The pattern is carried by the model's own wind field (summer and winter fields, blended with
// the same seasonal weight as precipitation), so it follows the trades, westerlies and polar easterlies, monsoon reversals and
// the flow around continents. Without wind data it falls back to u(lat) = -cos(4 lat). A varying wind would smear the pattern
// without limit, so two copies advected over a bounded window are cross-faded (a flow-map blend).
// Where clouds form comes from the model's precipitation: wet regions fill with cloud, dry ones stay clear, and the moving
// pattern is therefore thickened as it blows over wet ground and burns off over dry ground.
float cloudDensity(vec3 d) {
    float lat = asin(clamp(d.y, -1.0, 1.0));
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, lat * 0.31830989 + 0.5);
    vec2 pc = texture2D(cloudTex, uv).rg;
    float p = mix(pc.g, pc.r, cloudSeason);
    float cov = clamp(0.02 + 0.65 * pow(p, 1.5), 0.0, 0.67);
    vec3 east = normalize(vec3(-d.z, 0.0, d.x) + vec3(1e-5, 0.0, 0.0));
    vec3 north = cross(east, d);
    vec2 wv;                                            // (east, north), 0..1 in magnitude
    if (cloudWindOn > 0.5) {
        vec4 wt = texture2D(cloudWindTex, uv);
        wv = (mix(wt.zw, wt.xy, cloudSeason) * 2.0 - 1.0);
        wv *= pow(max(length(wv), 1e-4), -0.4);         // lift weak winds: speed -> speed^0.6
    } else {
        wv = vec2(-cos(4.0 * lat), 0.0);
    }
    vec3 vel = (east * wv.x + north * wv.y) * 0.6;      // chord length carried per cycle
    float ph = cloudDrift / 0.6;
    float f1 = fract(ph), f2 = fract(ph + 0.5);
    float w1 = 1.0 - abs(2.0 * f1 - 1.0);
    float n = w1 * cloudField(normalize(d - vel * f1), 0.0) + (1.0 - w1) * cloudField(normalize(d - vel * f2), 0.0);
    n = 0.5 + (n - 0.5) * 1.15;                           // averaging two copies flattens the contrast a little
    float th = 0.70 - 0.40 * cov;
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
varying vec3 vOP; varying float vHk; varying vec3 vNX; varying vec3 vNY; varying vec3 vNZ;
attribute vec3 triA; attribute vec3 triB; attribute vec3 triC;
varying vec3 vTA; varying vec3 vTB; varying vec3 vTC; varying vec3 vBary; varying vec3 vON;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vOP = position; vHk = (length(position) - 1.0) * ${R_KM}.0;
vTA = triA; vTB = triB; vTC = triC; vON = objectNormal;
int vi = gl_VertexID % 3; vBary = vec3(vi == 0 ? 1.0 : 0.0, vi == 1 ? 1.0 : 0.0, vi == 2 ? 1.0 : 0.0);
vNX = normalMatrix * vec3(1.0, 0.0, 0.0); vNY = normalMatrix * vec3(0.0, 1.0, 0.0); vNZ = normalMatrix * vec3(0.0, 0.0, 1.0);`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
varying vec3 vOP; varying float vHk; varying vec3 vNX; varying vec3 vNY; varying vec3 vNZ;
varying vec3 vTA; varying vec3 vTB; varying vec3 vTC; varying vec3 vBary; varying vec3 vON;
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
    {   // break the straight Voronoi edges: warp the barycentric weights of the corner colours with noise
        vec3 pl = vBary.x * vTA + vBary.y * vTB + vBary.z * vTC;
        vec3 nb = vec3(vnoise(vOP * 190.0), vnoise(vOP * 190.0 + 17.0), vnoise(vOP * 190.0 + 41.0)) * 0.65
                + vec3(vnoise(vOP * 520.0 + 5.0), vnoise(vOP * 520.0 + 23.0), vnoise(vOP * 520.0 + 59.0)) * 0.35 - 0.5;
        vec3 wb = max(vBary + nb * 0.95, 0.0);
        wb /= max(wb.x + wb.y + wb.z, 1e-4);
        diffuseColor.rgb += wb.x * vTA + wb.y * vTB + wb.z * vTC - pl;
        diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.0));
    }
    float n = 0.45 * vnoise(vOP * 60.0) + 0.30 * vnoise(vOP * 210.0) * lodw(210.0, fw)
            + 0.15 * vnoise(vOP * 760.0) * lodw(760.0, fw) + 0.10 * vnoise(vOP * 2600.0) * lodw(2600.0, fw);
    float lw = 0.45 + 0.30 * lodw(210.0, fw) + 0.15 * lodw(760.0, fw) + 0.10 * lodw(2600.0, fw);
    n = n / lw - 0.5;
    float land = smoothstep(-0.02, 0.05, vHk);   // 0 sea, 1 land
    float amp = mix(0.10, 0.34, land);
    diffuseColor.rgb *= 1.0 + amp * n;
    float tint = vnoise(vOP * 30.0) - 0.5;
    diffuseColor.rgb *= vec3(1.0 + 0.10 * tint, 1.0 + 0.04 * tint, 1.0 - 0.10 * tint) * land + vec3(1.0) * (1.0 - land);
    if (land > 0.5) {   // patchy vegetation / soil, and bare rock where the ground is steep
        float pa = (vnoise(vOP * 11.0) - 0.5) + 0.6 * (vnoise(vOP * 27.0) - 0.5) + 0.35 * (vnoise(vOP * 70.0) - 0.5) * lodw(70.0, fw);
        diffuseColor.rgb *= vec3(1.0 + 0.30 * pa, 1.0 + 0.12 * pa, 1.0 - 0.26 * pa);
        float pb = vnoise(vOP * 150.0 + 3.0) - 0.5;
        diffuseColor.rgb *= 1.0 + 0.16 * pb * smoothstep(0.0, 0.6, diffuseColor.g);
        vec3 nO0 = normalize(vOP);
        vec3 sv = vON - nO0 * dot(vON, nO0);
        float slope = length(sv) / max(dot(vON, nO0), 0.2);
        float rk = smoothstep(0.018, 0.075, slope + 0.02 * pa) * smoothstep(0.15, 0.7, vHk);
        float rn = 0.6 + 0.8 * vnoise(vOP * 240.0) * lodw(240.0, fw) + 0.5 * vnoise(vOP * 800.0) * lodw(800.0, fw);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.27, 0.235) * rn, clamp(rk * 0.75, 0.0, 0.75));
    }
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
    mat.customProgramCacheKey = () => oldKey.call(mat) + '+real5-' + type;
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
let cloudMesh = null, _cloudKey = null, _cloudDriftAcc = 0, _cloudEvoAcc = 0;

// Separable box blur of the RGBA8 wind texture (wraps in longitude). Cell-to-cell wind noise would otherwise displace the
// cloud pattern texel by texel and give it hard, broken edges; the winds that carry clouds are large-scale.
function blurWind(data, W, H, radius, passes) {
    const tmp = new Float32Array(W * H * 4), cur = new Float32Array(W * H * 4);
    for (let i = 0; i < cur.length; i++) cur[i] = data[i];
    const n = 2 * radius + 1;
    for (let pass = 0; pass < passes; pass++) {
        for (let j = 0; j < H; j++) for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += cur[(j * W + ((k % W) + W) % W) * 4 + c];
            for (let i = 0; i < W; i++) {
                tmp[(j * W + i) * 4 + c] = sum / n;
                sum += cur[(j * W + (i + radius + 1) % W) * 4 + c] - cur[(j * W + ((i - radius) % W + W) % W) * 4 + c];
            }
        }
        for (let i = 0; i < W; i++) for (let c = 0; c < 4; c++) {
            for (let j = 0; j < H; j++) {
                let sum = 0;
                for (let k = -radius; k <= radius; k++) sum += tmp[(Math.min(H - 1, Math.max(0, j + k)) * W + i) * 4 + c];
                cur[(j * W + i) * 4 + c] = sum / n;
            }
        }
    }
    for (let i = 0; i < cur.length; i++) data[i] = Math.round(cur[i]);
}

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
    const wE = [cd.r_wind_east_summer, cd.r_wind_north_summer, cd.r_wind_east_winter, cd.r_wind_north_winter];
    const haveWind = !!(wE[0] && wE[1] && wE[2] && wE[3]);
    // wind speed relative to the 95th percentile of each season (as the model's own 0..1 wind speed)
    const wRef = [1, 1];
    if (haveWind) for (let k = 0; k < 2; k++) {
        const sp = new Float32Array(N);
        for (let r = 0; r < N; r++) sp[r] = Math.hypot(wE[2 * k][r], wE[2 * k + 1][r]);
        sp.sort();
        wRef[k] = sp[Math.floor(0.95 * (N - 1))] || 1;
    }
    const wdata = new Uint8Array(W * H * 4).fill(128);
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
                if (haveWind) {
                    for (let k = 0; k < 2; k++) {
                        const e = wE[2 * k][best], n = wE[2 * k + 1][best], m = Math.hypot(e, n) || 1, sp = Math.min(1, m / wRef[k]);
                        wdata[(j * W + i) * 4 + 2 * k] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * e / m * sp)));
                        wdata[(j * W + i) * 4 + 2 * k + 1] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * n / m * sp)));
                    }
                }
            }
        }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    tex.needsUpdate = true;
    if (haveWind) blurWind(wdata, W, H, 10, 3);
    const wtex = new THREE.DataTexture(wdata, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    wtex.wrapS = THREE.RepeatWrapping; wtex.wrapT = THREE.ClampToEdgeWrapping;
    wtex.minFilter = wtex.magFilter = THREE.LinearFilter; wtex.generateMipmaps = false;
    wtex.needsUpdate = true;
    return { tex, wtex, haveWind };
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
        if (t) {
            if (realUniforms.cloudTex.value !== dummyTex) realUniforms.cloudTex.value.dispose();
            if (realUniforms.cloudWindTex.value !== dummyWind) realUniforms.cloudWindTex.value.dispose();
            realUniforms.cloudTex.value = t.tex; realUniforms.cloudWindTex.value = t.wtex; realUniforms.cloudWindOn.value = t.haveWind ? 1 : 0;
        }
        _cloudKey = cd.r_precip_summer;
    }
    const cm = ensureCloudMesh();
    cm.visible = true;
    const th = state.planetMesh.rotation.y;
    cm.rotation.y = th;
    const m = state.seasonMonth == null ? 6 : state.seasonMonth;
    realUniforms.cloudSeason.value = 0.5 * (1 + Math.cos(2 * Math.PI * (m - HYDROLOGY.summerMonth) / 12));
    // Prevailing winds carry the cloud pattern (the wind clock runs fast while Auto Rotate is on, slowly otherwise).
    const rot = document.getElementById('chkRotate');
    if (rot && rot.checked) { _cloudDriftAcc += 0.003; _cloudEvoAcc += 0.0035; }
    realUniforms.cloudEvo.value = _cloudEvoAcc + performance.now() * 1e-3 * 0.01;
    realUniforms.cloudDrift.value = _cloudDriftAcc + performance.now() * 1e-3 * 0.02;
    const s = sunUniforms.sunDir.value, c = Math.cos(th), sn = Math.sin(th);
    realUniforms.sunObj.value.set(s.x * c - s.z * sn, s.y, s.x * sn + s.z * c).normalize();
}

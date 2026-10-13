// Three.js scene setup: renderer, cameras, controls, lights, atmosphere, water, stars.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const canvas   = document.getElementById('canvas');
// Some browsers/WebViews refuse a context with antialiasing (or a high-performance
// GPU request), so retry with progressively safer settings before giving up.
function createRenderer() {
    const attempts = [
        { antialias: true },
        { antialias: false },
        { antialias: false, powerPreference: 'low-power' },
    ];
    let lastErr = null;
    for (const opts of attempts) {
        try { return new THREE.WebGLRenderer({ canvas, ...opts }); }
        catch (e) { lastErr = e; }
    }
    throw new Error('WebGL is not available in this browser or viewer. Try opening the page in a regular browser tab with hardware acceleration enabled. (' + (lastErr && lastErr.message) + ')');
}
export const renderer = createRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// Shadow mapping is only used with Realistic Elevation (see setShadowsWanted). The map is refreshed on
// demand (requestShadowUpdate) rather than every frame: it only changes when the sun, the planet or
// its rotation changes.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;

export const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x030308);

export const camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 200);
camera.position.set(0, 0.4, 2.8);

export const ctrl = new OrbitControls(camera, canvas);
ctrl.enableDamping = true; ctrl.dampingFactor = 0.06;
ctrl.enablePan = false;
ctrl.minDistance = 1.4; ctrl.maxDistance = 8;
ctrl.enableZoom = false; // disable built-in zoom; custom handler below

// Smooth zoom: wheel sets a target distance, each frame lerps toward it
let _zoomTarget = camera.position.distanceTo(ctrl.target);
const ZOOM_STEP   = 0.92;   // multiplier per tick (lower = faster zoom)
const ZOOM_SMOOTH = 0.12;   // lerp speed per frame (higher = snappier)

canvas.addEventListener('wheel', (e) => {
    if (!ctrl.enabled) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    _zoomTarget *= dir > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    _zoomTarget = THREE.MathUtils.clamp(_zoomTarget, ctrl.minDistance, ctrl.maxDistance);
}, { passive: false });

// Pinch-to-zoom for globe (touch)
let _pinchDist = 0;
canvas.addEventListener('touchstart', (e) => {
    if (!ctrl.enabled || e.touches.length !== 2) { _pinchDist = 0; return; }
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchDist = Math.sqrt(dx * dx + dy * dy);
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!ctrl.enabled || e.touches.length !== 2 || _pinchDist === 0) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ratio = _pinchDist / dist;
    _zoomTarget *= ratio;
    _zoomTarget = THREE.MathUtils.clamp(_zoomTarget, ctrl.minDistance, ctrl.maxDistance);
    _pinchDist = dist;
}, { passive: true });

canvas.addEventListener('touchend', () => { _pinchDist = 0; }, { passive: true });

export function tickZoom() {
    const v = new THREE.Vector3().subVectors(camera.position, ctrl.target);
    const cur = v.length();
    const next = THREE.MathUtils.lerp(cur, _zoomTarget, ZOOM_SMOOTH);
    if (Math.abs(next - cur) < 0.0001) return;
    v.setLength(next);
    camera.position.copy(ctrl.target).add(v);
}

const ambient = new THREE.AmbientLight(0xaabbcc, 3.5);
scene.add(ambient);
export const sun = new THREE.DirectionalLight(0xfff8ee, 1.5);
sun.position.set(5, 3, 4);
scene.add(sun);
// Orthographic shadow frustum around the planet (radius 1 at 10 units from the sun position).
sun.shadow.mapSize.set(4096, 4096);
{ const c = sun.shadow.camera; c.left = -1.15; c.right = 1.15; c.top = 1.15; c.bottom = -1.15; c.near = 8.5; c.far = 11.5; c.updateProjectionMatrix(); }
sun.shadow.bias = -0.00003;
sun.shadow.normalBias = 0.0002;
let _shadowsWanted = false;
export function requestShadowUpdate() { renderer.shadowMap.needsUpdate = true; }
export function setShadowsWanted(on) { _shadowsWanted = on; applySun(); }
// Uniforms so the river ribbons (a custom shader) can look up the same shadow map.
const _noShadowTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
_noShadowTex.needsUpdate = true;
export const shadowUniforms = {
    shadowMap: { value: _noShadowTex },
    shadowMat: { value: sun.shadow.matrix },
    shadowOn: { value: 0 },
};

// Sun lighting (Realistic mode). Off: the original soft, even light (strong ambient, so no visible night side).
// On: a world-fixed sun placed at the sub-solar point (longitude, and a latitude equal to the solar
// declination for the current month: +23.44 deg at the northern summer solstice), weak bluish
// ambient "skylight", so the planet has a lit day side, a terminator and a dim night side.
let _sunOn = false, _sunLon = 40, _sunMonth = 6, _tiltOn = false;
const _tiltQ = new THREE.Quaternion(), _sunWorld = new THREE.Vector3(5, 3, 4).normalize();
// The same light, as uniforms for custom shaders (river ribbons) that are not lit by three.js:
// outgoing = albedo * (ambient + sunRGB * max(0, N.L)) / PI, matching MeshLambertMaterial.
export const sunUniforms = {
    sunDir: { value: new THREE.Vector3(0, 0, 1) },
    sunRGB: { value: new THREE.Vector3() },
    ambRGB: { value: new THREE.Vector3() },
    dayOnly: { value: 0 },       // 1 in Realistic mode (a real sun with a night side); 0 = original flat lighting
};
function applySun() {
    _tiltQ.identity();
    if (!_sunOn) {
        ambient.intensity = 3.5; sun.intensity = 1.5; sun.position.set(5, 3, 4);
        _sunWorld.set(5, 3, 4).normalize();
    } else {
        ambient.intensity = 0.02; sun.intensity = 4.2;      // night side: almost black (just starlight)
        // The sun stays on the ecliptic (the equatorial plane); the seasons come from the planet's axis, which leans toward the
        // sun by the solar declination (+23.44 deg at the northern summer solstice, 0 at the equinoxes, -23.44 at the winter solstice).
        const dec = 23.44 * Math.sin(2 * Math.PI * (_sunMonth - 3) / 12) * Math.PI / 180;
        const lon = _sunLon * Math.PI / 180;
        _sunWorld.set(Math.cos(lon), 0, Math.sin(lon));
        if (_tiltOn) _tiltQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0).cross(_sunWorld).normalize(), dec);
        else _sunWorld.set(Math.cos(dec) * Math.cos(lon), Math.sin(dec), Math.cos(dec) * Math.sin(lon));   // no tilt (flat map): fall back to a moving sun
        sun.position.copy(_sunWorld).applyQuaternion(_tiltQ.clone().invert()).multiplyScalar(10);   // the light is a child of the (tilted) scene
    }
    scene.quaternion.copy(_tiltQ);
    sun.castShadow = _shadowsWanted && _sunOn;
    shadowUniforms.shadowOn.value = sun.castShadow ? 1 : 0;
    requestShadowUpdate();
    sunUniforms.dayOnly.value = _sunOn ? 1 : 0;
    sunUniforms.sunDir.value.copy(_sunWorld);
    sunUniforms.sunRGB.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
    sunUniforms.ambRGB.value.set(ambient.color.r, ambient.color.g, ambient.color.b).multiplyScalar(ambient.intensity);
}
function syncStars() { if (starsMesh) starsMesh.quaternion.copy(_tiltQ).invert(); }   // the stars do not tilt with the planet
export function setSunLighting(on) { _sunOn = on; applySun(); syncStars(); }
export function setSunLongitude(deg) { _sunLon = deg; applySun(); syncStars(); }
export function setSunMonth(m) { _sunMonth = m; applySun(); syncStars(); }
// Globe view in Realistic mode: tilt the planet's axis for the season (off in the flat map view).
export function setSeasonTilt(on) { if (on !== _tiltOn) { _tiltOn = on; applySun(); syncStars(); } }
applySun();

// Stars
export let starsMesh;
{ const g=new THREE.BufferGeometry(),p=[];
  for(let i=0;i<3000;i++){const th=Math.random()*Math.PI*2,ph=Math.acos(2*Math.random()-1),r=40+Math.random()*30;
    p.push(r*Math.sin(ph)*Math.cos(th),r*Math.sin(ph)*Math.sin(th),r*Math.cos(ph));}
  g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  starsMesh = new THREE.Points(g,new THREE.PointsMaterial({color:0xffffff,size:0.08}));
  scene.add(starsMesh); }

// Original atmosphere (non-Realistic mode): a simple blue rim glow on a shell of radius 1.12.
const atmosGlowMat = new THREE.ShaderMaterial({
    uniforms:{c:{value:new THREE.Color(0.35,0.6,1.0)}, fade:{value:1}},
    vertexShader:`varying vec3 vN,vP;void main(){vN=normalize(normalMatrix*normal);vP=(modelViewMatrix*vec4(position,1)).xyz;gl_Position=projectionMatrix*vec4(vP,1);}`,
    fragmentShader:`uniform vec3 c;uniform float fade;varying vec3 vN,vP;void main(){float r=1.0-max(0.0,dot(normalize(-vP),vN));gl_FragColor=vec4(c,pow(r,3.5)*0.55*fade);}`,
    transparent:true,side:THREE.FrontSide,depthWrite:false
});

// Realistic atmosphere: single-scattering Rayleigh (blue sky, red sunsets) plus Mie haze, ray-marched in the
// shell's fragment shader. Lengths are in planet radii; the shell's thickness T maps to 100 km, so
// the scale heights (8.5 km Rayleigh, 1.2 km Mie) and the per-km coefficients are scaled to match.
// That makes the exaggerated-size atmosphere look the same as the realistic one, just bigger.
// The planet (radius 1) blocks the view ray and casts a shadow, so the night side stays dark and
// the light turns orange-red along the terminator.
const atmosMat = new THREE.ShaderMaterial({
    uniforms:{ sunDirW:sunUniforms.sunDir, dayOnly:sunUniforms.dayOnly, Ra:{value:1.12}, Rg:{value:1.0}, fade:{value:1} },
    vertexShader:`varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
    fragmentShader:`
uniform vec3 sunDirW; uniform float dayOnly; uniform float Ra; uniform float Rg; uniform float fade; varying vec3 vW;
vec2 raySphere(vec3 o, vec3 d, float r){ float b=dot(o,d); float c=dot(o,o)-r*r; float h=b*b-c; if(h<0.0) return vec2(1e5,-1e5); h=sqrt(h); return vec2(-b-h,-b+h); }
void main(){
    float T = Ra - 1.0;                                         // atmosphere thickness (= 100 km)
    float HR = 0.085 * T, HM = 0.012 * T;                       // scale heights (8.5 km, 1.2 km of 100 km)
    float kmPerUnit = 100.0 / T;
    vec3 bR = vec3(5.8e-3, 13.5e-3, 33.1e-3) * kmPerUnit;       // Rayleigh extinction per unit length at sea level
    float bM = 21e-3 * kmPerUnit;                               // Mie
    vec3 ro = cameraPosition, rd = normalize(vW - ro);
    // Sun Lighting off: the planet is evenly lit, so light the atmosphere evenly too (a sun behind the
    // camera gives a uniform rim with no terminator or night side).
    vec3 sunDir = normalize(mix(normalize(ro), sunDirW, dayOnly));
    vec2 ta = raySphere(ro, rd, Ra);
    float t0 = max(ta.x, 0.0), t1 = ta.y;
    vec2 tg = raySphere(ro, rd, Rg);
    if (tg.x > 0.0) t1 = min(t1, tg.x);
    if (t1 <= t0) discard;
    const int N = 16; const int NL = 5;
    float ds = (t1 - t0) / float(N);
    float oR = 0.0, oM = 0.0;
    vec3 sR = vec3(0.0), sM = vec3(0.0);
    for (int i = 0; i < N; i++) {
        vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
        float h = max(length(p) - Rg, 0.0);
        float dR = exp(-h / HR) * ds, dM = exp(-h / HM) * ds;
        oR += dR; oM += dM;
        vec2 tsh = raySphere(p, sunDir, Rg);
        if (tsh.x > 0.0) continue;                              // in the planet's shadow
        float dl = raySphere(p, sunDir, Ra).y / float(NL);
        float lR = 0.0, lM = 0.0;
        for (int j = 0; j < NL; j++) {
            vec3 q = p + sunDir * (float(j) + 0.5) * dl;
            float hq = max(length(q) - Rg, 0.0);
            lR += exp(-hq / HR) * dl; lM += exp(-hq / HM) * dl;
        }
        vec3 attn = exp(-(bR * (oR + lR) + vec3(bM * 1.1 * (oM + lM))));
        sR += attn * dR; sM += attn * dM;
    }
    float mu = dot(rd, sunDir);
    float phR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
    const float g = 0.76;
    float phM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    vec3 col = 9.0 * (sR * bR * phR + sM * bM * phM);
    col = 1.0 - exp(-col * 1.3);                                // tone map
    gl_FragColor = vec4(col * fade, 1.0);
}`,
    transparent:true, blending:THREE.AdditiveBlending, side:THREE.FrontSide, depthWrite:false
});
export const atmosMesh = new THREE.Mesh(new THREE.SphereGeometry(1.12,64,64), atmosGlowMat);
scene.add(atmosMesh);

// Atmosphere size. Real: ~100 km (the Karman line) on a 6371 km planet, so a shell of radius
// 1.0157. With exaggerated relief it is scaled by the same factor as the relief (0.04 radius per
// 6 km of height, about 42x), so it keeps the same proportion to the mountains it sits above.
const ATMOS_BASE_RADIUS = 1.12;                                  // radius of the geometry above
const ATMOS_THICKNESS = 100 / 6371;
const RELIEF_EXAGGERATION = 0.04 / (6 / 6371);
export function setAtmosphereScale(realistic) {
    const radius = realistic ? 1 + ATMOS_THICKNESS : ATMOS_BASE_RADIUS;  // non-realistic: original size
    atmosMesh.material = realistic ? atmosMat : atmosGlowMat;            // scattering vs the original glow
    atmosMesh.scale.setScalar(radius / ATMOS_BASE_RADIUS);
    // Where the air stops. Exaggerated relief puts lowlands up to ~0.04 above radius 1, so the view
    // ray is ended a little above sea level; otherwise it would run through the dense bottom layer
    // inside the terrain and wash the land out white.
    atmosMat.uniforms.Rg.value = realistic ? 1.0 : 1.012;
}
// Fade the shell out as the camera enters it (back faces are culled, so it would pop otherwise).
atmosMesh.onBeforeRender = (r, sc, cam) => {
    const R = ATMOS_BASE_RADIUS * atmosMesh.scale.x;
    const u = atmosMesh.material.uniforms;
    u.fade.value = THREE.MathUtils.smoothstep(cam.position.length(), R * 0.92, R * 1.04);
    if (u.Ra) u.Ra.value = R;
};
setAtmosphereScale(false);

// Water sphere
// Lambert (diffuse only): no specular glint of the sun on the sea.
const waterMat = new THREE.MeshLambertMaterial({
    color:0x0c3a6e, transparent:true, opacity:0.55, depthWrite:false
});
export const waterMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0,80,80), waterMat);
waterMesh.receiveShadow = true;
scene.add(waterMesh);

// Equirectangular map camera & controls
export const mapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
mapCamera.position.set(0, 0, 5);
mapCamera.lookAt(0, 0, 0);

export function updateMapCameraFrustum() {
    const aspect = innerWidth / innerHeight;
    const mapAspect = 2;
    let halfW, halfH;
    if (aspect > mapAspect) {
        halfH = 1.15;
        halfW = halfH * aspect;
    } else {
        halfW = 2.3;
        halfH = halfW / aspect;
    }
    mapCamera.left = -halfW; mapCamera.right = halfW;
    mapCamera.top = halfH; mapCamera.bottom = -halfH;
    mapCamera.updateProjectionMatrix();
}
updateMapCameraFrustum();

export const mapCtrl = new OrbitControls(mapCamera, canvas);
mapCtrl.enableRotate = false;
mapCtrl.enableDamping = true;
mapCtrl.dampingFactor = 0.09;
mapCtrl.panSpeed = 1.4;
mapCtrl.screenSpacePanning = true;
mapCtrl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
mapCtrl.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
mapCtrl.minZoom = 0.5;
mapCtrl.maxZoom = 20;
mapCtrl.enableZoom = false; // custom handler below
mapCtrl.enabled = false;

// Smooth zoom for map view (orthographic)
let _mapZoomTarget = mapCamera.zoom;
const MAP_ZOOM_STEP   = 0.92;
const MAP_ZOOM_SMOOTH = 0.12;

canvas.addEventListener('wheel', (e) => {
    if (!mapCtrl.enabled) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    _mapZoomTarget *= dir < 0 ? 1 / MAP_ZOOM_STEP : MAP_ZOOM_STEP;
    _mapZoomTarget = THREE.MathUtils.clamp(_mapZoomTarget, mapCtrl.minZoom, mapCtrl.maxZoom);
}, { passive: false });

// Pinch-to-zoom for map (touch)
let _mapPinchDist = 0;
canvas.addEventListener('touchstart', (e) => {
    if (!mapCtrl.enabled || e.touches.length !== 2) { _mapPinchDist = 0; return; }
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _mapPinchDist = Math.sqrt(dx * dx + dy * dy);
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!mapCtrl.enabled || e.touches.length !== 2 || _mapPinchDist === 0) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ratio = dist / _mapPinchDist;
    _mapZoomTarget *= ratio;
    _mapZoomTarget = THREE.MathUtils.clamp(_mapZoomTarget, mapCtrl.minZoom, mapCtrl.maxZoom);
    _mapPinchDist = dist;
}, { passive: true });

canvas.addEventListener('touchend', () => { _mapPinchDist = 0; }, { passive: true });

export function tickMapZoom() {
    const cur = mapCamera.zoom;
    const next = THREE.MathUtils.lerp(cur, _mapZoomTarget, MAP_ZOOM_SMOOTH);
    if (Math.abs(next - cur) < 0.0001) return;
    mapCamera.zoom = next;
    mapCamera.updateProjectionMatrix();
}

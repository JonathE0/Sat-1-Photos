// CTS-SAT-1 3D model for the explore page.
//
// createSatellite() loads a glTF/GLB model of the spacecraft and returns an Object3D in a
// fixed frame, so the model can be swapped (e.g. for the team's own CAD) without touching
// the page code:
//
//   origin  = centre of mass (for a 3U, the centre of the body)
//   +Z      = long (3U) axis
//   -Y      = nadir face (the face that looks down at the Earth)
//   1 unit  = 1 metre
//
// A GLB that already follows that frame needs no options. A raw CAD export can be fitted
// with { rotation, metresPerUnit, centre } instead of editing the file. If the model can't
// be loaded, a procedural stand-in 3U is used so the page never breaks.
//
// Imports the bare specifier "three": the page needs an import map, e.g.
//   <script type="importmap">{"imports":{"three":"../globe/vendor/three.module.min.js"}}</script>

import * as THREE from 'three';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/libs/meshopt_decoder.module.js';

/** Default model: a public-domain NASA 3U CubeSat used until the CTS-SAT-1 CAD is found
 *  (see models/CREDITS.md). */
export const DEFAULT_MODEL_URL = new URL('./models/cubesat-3u.glb', import.meta.url).href;

/** 3U CubeSat envelope (CDS rev 14): 100 x 100 x 340.5 mm. Used by the stand-in. */
const U3 = { w: 0.1, l: 0.3405, rail: 0.0085 };

/**
 * PBR looks for materials, picked by keyword in the material name (first match wins).
 * Values are tuned for one directional "sun" plus a faint ambient. Colours are sRGB.
 * The bundled GLB already carries the same values; this table makes a swapped-in model
 * with sensibly named materials ("Solar cell", "Al 6061 rail", "Kapton", ...) look right.
 */
const MATERIAL_PRESETS = [
  [/interconnect|busbar|copper/i, { color: 0xc4945c, metalness: 0.9, roughness: 0.35 }],
  [/pcb|substrate|fr-?4|solar.?back/i, { color: 0x121216, metalness: 0.0, roughness: 0.55 }],
  [/solar|photovolt|\bcells?\b/i, { color: 0x2b3b82, metalness: 0.3, roughness: 0.2 }],
  [/gold|kapton|\bmli\b/i, { color: 0xd4a048, metalness: 1.0, roughness: 0.32 }],
  [/silver|foil/i, { color: 0xe1e2e6, metalness: 1.0, roughness: 0.22 }],
  [/black/i, { color: 0x0e0e0f, metalness: 0.2, roughness: 0.6 }],
  // Metals are kept part-diffuse: with nothing but black sky to reflect, fully metallic
  // aluminium would render near-black away from the sun glint.
  [/anodi[sz]ed.?dark|dark.?alumin/i, { color: 0x5c5d60, metalness: 0.5, roughness: 0.5 }],
  [/alumin|\brails?\b|frame|chassis|structure/i, { color: 0xbcbec2, metalness: 0.5, roughness: 0.45 }],
  [/white/i, { color: 0xdededc, metalness: 0.0, roughness: 0.7 }],
];

const HIGHLIGHT_EMISSIVE = new THREE.Color(0x182030);

/**
 * @param {object}  [opts]
 * @param {string|null} [opts.modelUrl]   GLB/glTF URL; null skips loading and uses the stand-in.
 * @param {number[]} [opts.rotation]      extra Euler XYZ rotation in degrees, applied to the
 *                                        loaded model to bring it into the frame above.
 * @param {number|'auto'} [opts.metresPerUnit='auto']  model units -> metres; 'auto' guesses
 *                                        mm / cm / m from the overall size.
 * @param {'origin'|'bbox'} [opts.centre='origin']  'bbox' moves the bounding-box centre to
 *                                        the origin (for CAD exports with a corner origin).
 * @param {boolean} [opts.materialPresets=true]  apply MATERIAL_PRESETS by material name.
 * @param {number}  [opts.earthshine=1]   strength of the faint Earth-reflected fill on the
 *                                        nadir side (0 = none, e.g. over the night side).
 * @param {number}  [opts.timeoutMs=20000] give up on the model and use the stand-in.
 */
export async function createSatellite({
  modelUrl = DEFAULT_MODEL_URL,
  rotation = null,
  metresPerUnit = 'auto',
  centre = 'origin',
  materialPresets = true,
  earthshine = 1,
  timeoutMs = 20000,
} = {}) {
  let model = null;
  let error = null;
  if (modelUrl) {
    try {
      const gltf = await loadGLTF(modelUrl, timeoutMs);
      model = gltf.scene;
      fitToFrame(model, { rotation, metresPerUnit, centre });
      if (materialPresets) applyPresets(model);
    } catch (e) {
      error = e;
      if (model) disposeTree(model);
      model = null;
      console.warn(`[satellite] could not load ${modelUrl}; using the stand-in 3U.`, e);
    }
  }
  const source = model ? 'model' : 'fallback';
  if (!model) model = buildStandIn();
  model.name = model.name || 'satellite-model';

  // Bounds in metres, before the display scale. The click box and outline hug the body;
  // deployables (antennas, booms) would make them far larger than what people aim at.
  model.updateMatrixWorld(true);
  const fullBox = new THREE.Box3().setFromObject(model);
  const box = bodyBounds(model);
  if (box.isEmpty()) box.copy(fullBox);

  // object3d (placed by the page) > scaler (setScale) > model, hit proxy, outline
  const object3d = new THREE.Group();
  object3d.name = 'CTS-SAT-1';
  const scaler = new THREE.Group();
  scaler.name = 'satellite-scale';
  object3d.add(scaler);
  scaler.add(model);

  // Earth-reflected light. A tiny cube map in the satellite's own frame (Earth below -Y),
  // re-oriented every frame so it follows the nadir face wherever the page points it.
  const envMap = makeEarthshineCube();
  const envRotation = new THREE.Euler(0, 0, 0, 'ZYX');
  const materials = collectMaterials(model);
  const baseEmissive = new Map();
  for (const m of materials) {
    if (m.emissive) baseEmissive.set(m, m.emissive.clone());
    if (m.isMeshStandardMaterial && envMap) {
      m.envMap = envMap;
      m.envMapRotation = envRotation; // shared, updated in place below
      m.envMapIntensity = earthshine;
    }
  }
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const syncEnv = () => {
    object3d.matrixWorld.decompose(tmpP, q, tmpS);
    // three applies the material's envMapRotation with negated angles; with order ZYX
    // the negated angles give the transpose of R(XYZ), i.e. world -> satellite frame.
    e.setFromQuaternion(q, 'XYZ');
    envRotation.set(e.x, e.y, e.z, 'ZYX');
  };
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (!envMap) return;
    const prev = o.onBeforeRender;
    o.onBeforeRender = function (...args) {
      syncEnv();
      prev.apply(this, args);
    };
  });

  // Click target: an invisible padded box, much easier to hit than the thin geometry.
  const size = box.getSize(new THREE.Vector3());
  const pad = Math.max(size.x, size.y, size.z) * 0.06;
  const hitBox = box.clone().expandByScalar(pad);
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(...hitBox.getSize(new THREE.Vector3()).toArray()),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitBox.getCenter(hit.position);
  hit.name = 'satellite-hit';
  hit.userData.satellite = true;
  scaler.add(hit);

  // Highlight: thin corner brackets around the bounds plus a slight brighten.
  const outline = makeCornerBrackets(box.clone().expandByScalar(pad * 0.6));
  outline.visible = false;
  scaler.add(outline);

  let highlighted = false;
  let disposed = false;

  const api = {
    object3d,
    hitObjects: [hit],
    /** 'model' or 'fallback' (stand-in), and the load error if any. */
    source,
    error,
    /** Overall size in metres including deployables (before setScale). */
    sizeMetres: fullBox.getSize(new THREE.Vector3()),
    /** Body bounds in metres (no deployables), in object3d's frame before setScale. */
    bodyBounds: box.clone(),
    setScale(unitsPerMetre) {
      const s = Number(unitsPerMetre);
      if (Number.isFinite(s) && s > 0) scaler.scale.setScalar(s);
    },
    setHighlight(on) {
      on = Boolean(on);
      if (on === highlighted || disposed) return;
      highlighted = on;
      outline.visible = on;
      for (const [m, base] of baseEmissive) {
        m.emissive.copy(base);
        if (on) m.emissive.add(HIGHLIGHT_EMISSIVE);
      }
    },
    /** 0..1+, e.g. fade to 0 when the ground below is in night. */
    setEarthshine(k) {
      for (const m of materials) if (m.isMeshStandardMaterial) m.envMapIntensity = Math.max(0, k);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object3d.removeFromParent();
      object3d.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) disposeMaterial(m);
      });
      if (envMap) envMap.dispose();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------

function loadGLTF(url, timeoutMs) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const load = loader.loadAsync(url);
  if (!(timeoutMs > 0)) return load;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([load, timeout]).then(
    (gltf) => { clearTimeout(timer); return gltf; },
    (err) => {
      clearTimeout(timer);
      // If the load finishes after the timeout, free it.
      load.then((g) => disposeTree(g.scene), () => {});
      throw err;
    },
  );
}

function fitToFrame(model, { rotation, metresPerUnit, centre }) {
  if (Array.isArray(rotation)) {
    const [x = 0, y = 0, z = 0] = rotation.map(THREE.MathUtils.degToRad);
    model.rotation.set(x, y, z, 'XYZ');
  }
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) throw new Error('model has no geometry');
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  let k = Number(metresPerUnit);
  if (metresPerUnit === 'auto' || !(k > 0)) {
    // A CubeSat is 0.1-1 m without deployables, a few metres at most with them.
    k = maxDim > 50 ? 0.001 : maxDim > 10 ? 0.01 : 1;
  }
  model.scale.multiplyScalar(k);
  if (centre === 'bbox') model.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(k));
  model.updateMatrixWorld(true);
}

/** Parts named like this are left out of the click box / outline bounds. */
const DEPLOYABLE_NAME = /antenna|boom|whip|tape.?spring|deployable/i;

function bodyBounds(root) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let p = o; p && p !== root.parent; p = p.parent) if (DEPLOYABLE_NAME.test(p.name || '')) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box;
}

function applyPresets(root) {
  for (const m of collectMaterials(root)) {
    if (!m.isMeshStandardMaterial) continue;
    const hit = MATERIAL_PRESETS.find(([re]) => re.test(m.name || ''));
    if (!hit) continue;
    const p = hit[1];
    if (!m.map) m.color.setHex(p.color);
    m.metalness = p.metalness;
    m.roughness = p.roughness;
    if (m.metalnessMap || m.roughnessMap) { m.metalnessMap = null; m.roughnessMap = null; }
    m.needsUpdate = true;
  }
}

function collectMaterials(root) {
  const set = new Set();
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) set.add(m);
  });
  return [...set];
}

function disposeMaterial(m) {
  for (const key of Object.keys(m)) {
    const v = m[key];
    if (v && v.isTexture && key !== 'envMap') v.dispose();
  }
  m.dispose();
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) disposeMaterial(m);
  });
}

/** Cube map of the sky seen from low Earth orbit, in the satellite's frame: the Earth fills
 *  everything more than ~20 deg below the horizon (-Y), with a thin bright limb, and space
 *  above is black. Mean radiance is roughly the sunlit Earth's (albedo ~0.3). */
function makeEarthshineCube(size = 32) {
  if (typeof document === 'undefined') return null;
  const dip = THREE.MathUtils.degToRad(-20);          // horizon dip at ~500 km
  const earth = [0.10, 0.15, 0.24];                   // linear RGB
  const limb = [0.20, 0.30, 0.50];
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = (2 * (i + 0.5)) / size - 1;
        const v = (2 * (j + 0.5)) / size - 1;
        // Only the elevation matters, so only the y component of the face direction
        // (faces in +X, -X, +Y, -Y, +Z, -Z order; v runs top to bottom).
        const dy = f === 2 ? 1 : f === 3 ? -1 : -v;
        const elev = Math.asin(dy / Math.hypot(1, u, v));
        let rgb = [0, 0, 0];
        if (elev < dip) {
          // a little brighter towards nadir (less limb darkening / more cloud seen face-on)
          const t = Math.min(1, (dip - elev) / (Math.PI / 2 + dip));
          const k = 0.75 + 0.25 * t;
          rgb = earth.map((x) => x * k);
        } else if (elev < dip + 0.05) {
          rgb = limb;
        }
        const o = (j * size + i) * 4;
        img.data[o] = Math.round(linearToSrgb(rgb[0]) * 255);
        img.data[o + 1] = Math.round(linearToSrgb(rgb[1]) * 255);
        img.data[o + 2] = Math.round(linearToSrgb(rgb[2]) * 255);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    faces.push(c);
  }
  const tex = new THREE.CubeTexture(faces);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function linearToSrgb(x) {
  x = Math.min(1, Math.max(0, x));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function makeCornerBrackets(box) {
  const { min, max } = box;
  const size = box.getSize(new THREE.Vector3());
  const len = Math.min(size.x, size.y, size.z) * 0.35;
  const pts = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    const sx = x === min.x ? 1 : -1, sy = y === min.y ? 1 : -1, sz = z === min.z ? 1 : -1;
    pts.push(x, y, z, x + sx * len, y, z);
    pts.push(x, y, z, x, y + sy * len, z);
    pts.push(x, y, z, x, y, z + sz * Math.max(len, size.z * 0.12));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0xdce6ff, transparent: true, opacity: 0.75, depthWrite: false,
  }));
  lines.name = 'satellite-outline';
  lines.raycast = () => {};
  return lines;
}

// ---- Procedural stand-in -------------------------------------------------------------

function presetMaterial(name, extra = {}) {
  const p = MATERIAL_PRESETS.find(([re]) => re.test(name))[1];
  return new THREE.MeshStandardMaterial({
    name, color: p.color, metalness: p.metalness, roughness: p.roughness, ...extra,
  });
}

/** Cells on a body-mounted panel: 7 triple-junction cells (cut corners) on black PCB. */
function makeCellTexture() {
  if (typeof document === 'undefined') return null;
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#141418';
  g.fillRect(0, 0, W, H);
  const n = 7, gap = 6, margin = 6;
  const ch = (H - 2 * margin - (n - 1) * gap) / n;
  const cw = W - 2 * margin;
  for (let k = 0; k < n; k++) {
    const x = margin, y = margin + k * (ch + gap), cut = 10;
    g.beginPath();
    g.moveTo(x + cut, y); g.lineTo(x + cw, y); g.lineTo(x + cw, y + ch);
    g.lineTo(x + cut, y + ch); g.lineTo(x, y + ch - cut); g.lineTo(x, y + cut); g.closePath();
    g.fillStyle = k % 2 ? '#2b3b82' : '#2e3e86';
    g.fill();
    g.strokeStyle = 'rgba(190,200,230,0.18)';     // grid fingers
    g.lineWidth = 1;
    for (let fx = x + 6; fx < x + cw; fx += 6) { g.beginPath(); g.moveTo(fx, y + 2); g.lineTo(fx, y + ch - 2); g.stroke(); }
    g.fillStyle = '#c4945c';                       // busbar
    g.fillRect(x + cw - 4, y + 2, 2, ch - 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildStandIn() {
  const group = new THREE.Group();
  group.name = 'standin-3u';
  const { w, l, rail } = U3;
  const half = w / 2;
  const alu = presetMaterial('aluminium rail');
  const black = presetMaterial('black anodised');
  const gold = presetMaterial('gold kapton');
  const tapeSpring = presetMaterial('silver foil', { roughness: 0.3 });
  const cellMap = makeCellTexture();
  const cells = cellMap
    ? new THREE.MeshStandardMaterial({ name: 'solar cells (stand-in)', map: cellMap, metalness: 0.3, roughness: 0.2 })
    : presetMaterial('solar cell');

  const box = (sx, sy, sz, mat, x = 0, y = 0, z = 0, name = '') => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    m.name = name;
    group.add(m);
    return m;
  };

  // Four corner rails, full length.
  const r = half - rail / 2;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(rail, rail, l, alu, sx * r, sy * r, 0, 'rail');
  // Inner structure (seen in the gaps) and the two end plates, recessed inside the rails.
  const plateZ = l / 2 - 0.0095;
  box(w - 0.012, w - 0.012, 2 * plateZ, black, 0, 0, 0, 'body');
  for (const sz of [-1, 1]) box(w - 0.0006, w - 0.0006, 0.003, alu, 0, 0, sz * plateZ, 'end-plate');

  // Body-mounted solar panels on the four long faces, between the rails
  // (PCB + cell texture on top), outer surface just inside the rail faces.
  const panelW = w - 2 * rail - 0.001;
  const panelL = l - 0.03;
  const t = 0.0016;
  const pcb = presetMaterial('solar panel pcb');
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]].map((v) => new THREE.Vector3(...v));
  for (const n of normals) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(panelW, t, panelL), pcb);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(panelW - 0.002, panelL - 0.002), cells);
    // Panel built facing +Y, then turned to face n (the long side stays on Z).
    top.rotation.x = -Math.PI / 2;
    top.position.y = t / 2 + 0.0001;
    const holder = new THREE.Group();
    holder.add(p, top);
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    holder.position.copy(n).multiplyScalar(half - 0.0008 - t / 2);
    holder.name = 'solar-panel';
    group.add(holder);
  }

  // Antenna deployer on the +Z end, with four deployed UHF tape-spring antennas.
  const modZ = plateZ + 0.0015 + 0.003;
  box(panelW, panelW, 0.006, black, 0, 0, modZ, 'antenna-module');
  box(panelW * 0.6, panelW * 0.6, 0.0004, gold, 0, 0, modZ + 0.0032, 'antenna-module-kapton');
  const tape = 0.17; // ~quarter wave at 437 MHz
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    // length radial, 0.4 mm thick, 4 mm wide (along Z)
    const m = new THREE.Mesh(new THREE.BoxGeometry(tape, 0.0004, 0.004), tapeSpring);
    const d = panelW / 2 - 0.002 + tape / 2;
    m.position.set(Math.cos(a) * d, Math.sin(a) * d, modZ);
    m.rotation.z = a;
    m.name = 'uhf-antenna';
    group.add(m);
  }

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

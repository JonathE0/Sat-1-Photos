// FrontierSat 3D model for the explore page.
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

/** Default model: FrontierSat's outside, from the team's CAD (see models/CREDITS.md). */
export const DEFAULT_MODEL_URL = new URL('./models/frontiersat.glb', import.meta.url).href;

/** 3U CubeSat envelope (CDS rev 14): 100 x 100 x 340.5 mm. Used by the stand-in. */
const U3 = { w: 0.1, l: 0.3405, rail: 0.0085 };

/**
 * PBR looks for materials, picked by keyword in the material name (first match wins).
 * Values are tuned for one directional "sun" plus a faint ambient. Colours are sRGB.
 * Only for a material the model left at glTF's defaults: the bundled GLB carries its own,
 * fuller looks (clear-coated boards and cover glass, iridescent cells: models/CREDITS.md),
 * and this table makes a swapped-in model with sensibly named materials ("Solar cell",
 * "Al 6061 rail", "Kapton", ...) look right.
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
 * At night the UHF antenna's tapes glow faintly cool, so they read as thin silver lines against
 * black space: 3 mm of mirror-like metal would otherwise vanish there. Linear RGB. (setSky)
 */
const NIGHT_TAPE_SHEEN = new THREE.Color().setRGB(0.13, 0.15, 0.2);
const NIGHT_SHEEN_PARTS = /antenna tape|antenna hinge/i;

/**
 * What the satellite's parts are, for the page to say by the pointer close up: [the model's
 * node name, part], first match wins. A part is { name, note }, or a function of where the
 * pointer's ray met it (metres, in the frame at the top of this file) that gives one. A node
 * that matches nothing (screws, connectors) is looked through to whatever is behind it.
 * `shown` adds how the model draws a part that unfolds, by its node's "(deployed)" or "(stowed)".
 * The words follow the About page's (index.html), so the site says one thing about each.
 */
const ATTITUDE_NOTE = 'It helps the satellite tell which way it faces.';
const PARTS = [
  [/gnss|gps/i, {
    name: 'GNSS antenna',
    note: 'The patch on the back. It listens to navigation satellites, such as GPS, for position and time.',
  }],
  [/antenna/i, {
    name: 'UHF antennas',
    note: 'Four tapes: the satellite’s radio link with the ground.',
    shown: { deployed: 'Shown unrolled.', stowed: 'Shown rolled away, as at launch.' },
  }],
  [/boom/i, {
    name: 'Deployable boom',
    note: 'A new boom of 3D-printed carbon fibre, designed to reach 1 143 mm when it opens.',
    shown: { stowed: 'Shown rolled up in its mount.' },
  }],
  [/magnetometer/i, {
    name: 'Magnetometer',
    note: `Measures the Earth’s magnetic field. ${ATTITUDE_NOTE}`,
    shown: { deployed: 'Shown swung out on its arm.', stowed: 'Shown folded against the body, as at launch.' },
  }],
  [/coarse.sun/i, {
    name: 'Coarse sun sensor',
    note: 'A small light sensor. Several around the body tell roughly where the Sun is.',
  }],
  // the two attitude cameras: the nadir camera on the face that looks down (-Y), and on the face
  // that looks up the zenith camera, which is the team's fine sun sensor
  [/sun.sensor/i, (p) => (p.y < 0
    ? { name: 'Nadir camera', note: `An attitude camera on the side that faces the Earth. ${ATTITUDE_NOTE}` }
    : {
      name: 'Fine sun sensor',
      note: `The zenith camera, on the side that faces away from the Earth. It finds just where the Sun is. ${ATTITUDE_NOTE}`,
    })],
  [/camera/i, {
    name: 'Main camera',
    note: 'Takes the pictures on this site. It is there mostly to watch the boom unfold.',
  }],
  [/switch/i, {
    name: 'Deployment switch',
    note: 'Pressed in while the satellite sat in its launcher, and released when it was let go.',
  }],
  [/solar/i, {
    name: 'Solar panels',
    note: 'Turn sunlight into the satellite’s electricity.',
  }],
  [/^structure$|frame|chassis/i, { name: 'Frame', note: 'Aluminium, 10 × 10 × 34 cm: the size called a 3U CubeSat.' }],
];
/**
 * The plasma imager is inside, behind its faceplate: the body's end face at +Z, which looks
 * the way the satellite flies. It has no mesh of its own (the model is the outside only, and
 * the face has an opening a ray goes straight through), so a ray that enters the body through
 * that face names it, unless it meets something standing on the face first.
 */
const MPI = {
  name: 'Mini Plasma Imager (MPI)',
  note: 'The main instrument. It measures winds of charged gas high above the Earth, '
    + 'through this face, which looks the way the satellite flies.',
};
const MPI_FACE = { inset: 0.007, half: 0.049 }; // metres: the plate lies this far in from the rails' ends, and is this wide either way

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
 * @param {number}  [opts.timeoutMs=20000] start with the stand-in if the model takes longer;
 *                                        the result's `late` then brings the model when it comes.
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
  const prepare = (gltf) => {
    const model = gltf.scene;
    try {
      fitToFrame(model, { rotation, metresPerUnit, centre });
      if (materialPresets) applyPresets(model);
    } catch (e) {
      disposeTree(model);
      throw e;
    }
    return model;
  };
  const standIn = (e) => {
    console.warn(`[satellite] could not load ${modelUrl}; using the stand-in 3U.`, e);
    return null;
  };
  let model = null;
  let error = null;
  let late = null;
  if (modelUrl) {
    const load = loadGLTF(modelUrl);
    try {
      const first = await withinTime(load, timeoutMs);
      if (first) model = prepare(first);
      // a slow line, not a failure: the stand-in for now, and the model when it comes
      else late = load.then(prepare).then((m) => assemble(m, 'model', null, earthshine), standIn);
    } catch (e) {
      error = e;
      standIn(e);
    }
  }
  const api = assemble(model || buildStandIn(), model ? 'model' : 'fallback', error, earthshine);
  /** A promise of the real satellite (or null if it never comes), when this is a stand-in for now. */
  api.late = late;
  return api;
}

/** One satellite around a model that is already in the frame described at the top. */
function assemble(model, source, error, earthshine) {
  model.name = model.name || 'satellite-model';

  // Bounds in metres, before the display scale. The click box and outline hug the body;
  // deployables (antennas, booms) would make them far larger than what people aim at.
  model.updateMatrixWorld(true);
  const fullBox = new THREE.Box3().setFromObject(model);
  const box = bodyBounds(model);
  if (box.isEmpty()) box.copy(fullBox);

  // object3d (placed by the page) > scaler (setScale) > model, hit proxy, outline
  const object3d = new THREE.Group();
  object3d.name = 'FrontierSat';
  const scaler = new THREE.Group();
  scaler.name = 'satellite-scale';
  object3d.add(scaler);
  scaler.add(model);

  // Earth-reflected light. A tiny cube map in the satellite's own frame (Earth below -Y),
  // re-oriented every frame so it follows the nadir face wherever the page points it.
  const envMap = makeEarthshineCube();
  let nightEnv = null; // the night Earth's, made the first time it's needed (setSky)
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
  const tmpSize = new THREE.Vector3(); // fitShadow's
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

  // The parts a pointer can name (PARTS), and a box around all of them, deployables too: a
  // ray that misses it meets no part, which saves trying every triangle.
  const partMeshes = [];
  const partTmp = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== model.parent; p = p.parent) {
      const part = PARTS.find(([re]) => re.test(p.name || ''));
      if (!part) continue;
      const how = part[1].shown?.[/deployed/i.test(p.name) ? 'deployed' : /stow/i.test(p.name) ? 'stowed' : ''];
      o.userData.part = how ? { name: part[1].name, note: `${part[1].note} ${how}` } : part[1];
      partMeshes.push(o);
      return;
    }
  });
  // The antenna's tapes are a few millimetres wide, a pixel or two on screen: each gets an
  // unseen box around it to point at, one per side of the body they run out from.
  const unseen = new THREE.MeshBasicMaterial({ visible: false });
  const tapeBoxes = [0, 1, 2, 3].map(() => new THREE.Box3());
  for (const o of [...partMeshes]) {
    if (!/tape/i.test(o.name) && !/tape/i.test(o.parent?.name || '')) continue;
    const at = o.geometry.attributes.position;
    for (let i = 0; i < at.count; i++) {
      partTmp.fromBufferAttribute(at, i).applyMatrix4(o.matrixWorld);
      const side = Math.abs(partTmp.x) > Math.abs(partTmp.y) ? (partTmp.x > 0 ? 0 : 1) : (partTmp.y > 0 ? 2 : 3);
      tapeBoxes[side].expandByPoint(partTmp);
    }
    for (const b of tapeBoxes) {
      if (b.isEmpty()) continue;
      b.expandByScalar(0.004);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(...b.getSize(new THREE.Vector3()).toArray()), unseen);
      b.getCenter(proxy.position);
      proxy.name = 'satellite-tape-reach';
      proxy.userData.part = o.userData.part;
      scaler.add(proxy);
      partMeshes.push(proxy);
      b.makeEmpty();
    }
  }
  const reach = new THREE.Mesh(
    new THREE.BoxGeometry(...fullBox.getSize(new THREE.Vector3()).addScalar(pad).toArray()),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  fullBox.getCenter(reach.position);
  reach.name = 'satellite-reach';
  scaler.add(reach);
  const partPoint = new THREE.Vector3();
  const partRay = new THREE.Ray();
  const toLocal = new THREE.Matrix4();
  const isFrame = (part) => typeof part === 'object' && part.name === 'Frame';

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
    /**
     * Fits a directional light's shadow tightly round the whole satellite (deployables and all)
     * at its current scale, so its parts shade one another: the antennas, the magnetometer's arm,
     * the GNSS puck and the camera on the body. Call it after placing the light and its target
     * (on the satellite) each frame; the renderer needs shadowMap.enabled and the light castShadow.
     */
    fitShadow(light) {
      const r = 0.5 * fullBox.getSize(tmpSize).length() * scaler.scale.x * 1.05;
      const d = light.position.distanceTo(light.target.position);
      const cam = light.shadow.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = Math.max(d * 1e-3, d - r);
      cam.far = d + r;
      cam.updateProjectionMatrix();
      // biases in the satellite's own size, so they hold at every zoom
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = r * 0.004;
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
    /**
     * The part a ray meets first, as { name, note }, or null. It tries the model's triangles,
     * so it's for a pointer at rest or a tap, not for every frame.
     */
    partAt(raycaster) {
      if (disposed || !partMeshes.length || !raycaster.intersectObject(reach, false).length) return null;
      // how far along the ray (metres, in the satellite's frame) it goes in through the +Z face, if it does
      partRay.copy(raycaster.ray).applyMatrix4(toLocal.copy(scaler.matrixWorld).invert());
      let face = Infinity;
      if (source === 'model' && partRay.direction.z < -1e-6) {
        const t = (box.max.z - MPI_FACE.inset - partRay.origin.z) / partRay.direction.z;
        partRay.at(t, partPoint);
        if (t > 0 && Math.abs(partPoint.x) < MPI_FACE.half && Math.abs(partPoint.y) < MPI_FACE.half) face = t;
      }
      for (const h of raycaster.intersectObjects(partMeshes, false)) {
        const part = h.object.userData.part;
        const at = scaler.worldToLocal(partPoint.copy(h.point));
        // past the face, or the face's own metal: it's the imager's faceplate
        if (face < Infinity && (isFrame(part) || at.distanceTo(partRay.origin) > face)) return MPI;
        const found = typeof part === 'function' ? part(at) : part;
        if (found) return found;
      }
      return face < Infinity ? MPI : null;
    },
    /** 0..1+, e.g. fade to 0 when the ground below is in night. */
    setEarthshine(k) {
      for (const m of materials) if (m.isMeshStandardMaterial) m.envMapIntensity = Math.max(0, k);
    },
    /**
     * What the shiny parts reflect, by the Sun's height over the ground below (degrees): the
     * sunlit Earth by day, dimming through twilight to 12%, and once the ground is dark (the Sun
     * 8 degrees down) the night Earth: its towns' lights, the airglow along the limb, stars.
     */
    setSky(groundSunDeg) {
      if (!envMap) return;
      const g = Number(groundSunDeg) || 0;
      const night = g < -8;
      const map = night ? (nightEnv ||= makeEarthshineCube(128, true)) : envMap;
      const t = Math.min(1, Math.max(0, (g + 8) / 12));
      const k = night ? 1 : 0.12 + 0.88 * t * t * (3 - 2 * t);
      for (const m of materials) {
        if (!m.isMeshStandardMaterial) continue;
        if (m.envMap !== map) m.envMap = map; // the same kind of map: no shader change
        m.envMapIntensity = k;
        if (NIGHT_SHEEN_PARTS.test(m.name || '') && baseEmissive.has(m)) {
          const base = baseEmissive.get(m);
          base.setRGB(0, 0, 0);
          if (night) base.copy(NIGHT_TAPE_SHEEN);
          m.emissive.copy(base);
          if (highlighted) m.emissive.add(HIGHLIGHT_EMISSIVE);
        }
      }
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
      if (nightEnv) nightEnv.dispose();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------

function loadGLTF(url) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.loadAsync(url);
}

/** The load's result, or null if it is still going after `timeoutMs` (0 waits for as long as it takes). */
function withinTime(load, timeoutMs) {
  if (!(timeoutMs > 0)) return load;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([load, timeout]).finally(() => clearTimeout(timer));
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

/** A material left at glTF's defaults (white, fully metallic, fully rough, no maps): no look chosen. */
const unstyled = (m) => !m.map && !m.metalnessMap && !m.roughnessMap && m.metalness === 1 && m.roughness === 1
  && m.color.r > 0.999 && m.color.g > 0.999 && m.color.b > 0.999;

function applyPresets(root) {
  for (const m of collectMaterials(root)) {
    if (!m.isMeshStandardMaterial || !unstyled(m)) continue; // the model chose its own look
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

/**
 * What the satellite's shiny parts reflect, in its own frame (the Earth below, -Y; assemble()
 * turns it with the satellite): the sunlit Earth filling the sky more than 22 deg below the
 * horizon (at 500 km), ocean and some land under drifting cloud, hazier towards the limb, a thin
 * blue glow along the limb, and black space above. The cloud is noise on the Earth's surface
 * where each direction meets it, so it is continuous across the cube's faces. Linear values sit
 * where a 0.3-albedo Earth would beside the scene's sun (3.2): ocean about 0.1, cloud about 0.6.
 * setEarthshine dims it all over the night side.
 */
function makeEarthshineCube(size = 128, night = false) {
  if (typeof document === 'undefined') return null;
  const R = 6371;
  const H = 500;
  const dip = -Math.acos(R / (R + H)); // the horizon, 22 deg down
  const GLOW = 0.06; // the limb glow's height, radians
  const ocean = [0.030, 0.060, 0.140];
  const land = [0.085, 0.080, 0.055];
  const cloud = [0.60, 0.62, 0.66];
  const haze = [0.16, 0.26, 0.50];
  const glow = [0.22, 0.36, 0.75];
  // night: the ground nearly black under its city lights, and just above the limb the thin band
  // of airglow (green, about 100 km up) that orbit photographs show; stars above
  const nightGround = [0.006, 0.009, 0.018];
  const moonlitCloud = [0.035, 0.042, 0.06]; // cloud tops under a part-lit Moon, so metal facing down keeps a sheen
  const cityLight = [1.0, 0.62, 0.28];
  const airglow = [0.08, 0.22, 0.11];
  const AIRGLOW_UP = 0.02; // radians above the limb
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const faces = [];
  for (let f = 0; f < 6; f++) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const s = (2 * (i + 0.5)) / size - 1;
        const t = (2 * (j + 0.5)) / size - 1;
        // the cube map's own face layout (+X, -X, +Y, -Y, +Z, -Z), t running top to bottom
        let x; let y; let z;
        switch (f) {
          case 0: x = 1; y = -t; z = -s; break;
          case 1: x = -1; y = -t; z = s; break;
          case 2: x = s; y = 1; z = t; break;
          case 3: x = s; y = -1; z = -t; break;
          case 4: x = s; y = -t; z = 1; break;
          default: x = -s; y = -t; z = -1;
        }
        const len = Math.hypot(x, y, z);
        x /= len; y /= len; z /= len;
        const elev = Math.asin(y);
        let rgb = [0, 0, 0];
        if (elev < dip) {
          // where this direction meets the Earth (centre R + H below), as a point on the unit sphere
          const b = -(R + H) * y;
          const d = b - Math.sqrt(Math.max(0, b * b - ((R + H) ** 2 - R * R)));
          const px = (d * x) / R;
          const py = (d * y + R + H) / R;
          const pz = (d * z) / R;
          const isLand = smooth(0.56, 0.60, fbm(px * 2.2 + 11.3, py * 2.2, pz * 2.2 - 4.1));
          const isCloud = smooth(0.50, 0.66, fbm(px * 7 - 3.7, py * 7 + 1.9, pz * 7 + 8.2));
          if (night) {
            // towns: specks on land, in clusters, dimmed where cloud lies over them
            const town = smooth(0.66, 0.74, fbm(px * 40 + 2.1, py * 40 - 7.3, pz * 40 + 5.9)) * isLand * (1 - 0.7 * isCloud);
            rgb = mix(mix(nightGround, moonlitCloud, isCloud), cityLight.map((v) => v * 0.5), town);
          } else {
            rgb = mix(mix(ocean, land, isLand), cloud, isCloud);
            // the view grazes more air towards the limb
            rgb = mix(rgb, haze, 0.6 * (1 - smooth(0, 0.25, dip - elev)));
          }
        } else if (night) {
          const a = (elev - dip - AIRGLOW_UP) / 0.012;
          rgb = airglow.map((v) => v * Math.exp(-a * a));
          // a sparse field of stars, fixed by the direction's own cell
          const star = valueNoise(x * 300 + 0.5, y * 300 + 0.5, z * 300 + 0.5);
          if (elev > dip + 0.05 && star > 0.985) rgb = rgb.map((v) => v + (star - 0.985) * 40);
        } else if (elev < dip + GLOW) {
          rgb = glow.map((v) => v * (1 - (elev - dip) / GLOW) ** 1.5);
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

/** Smooth value noise in 3D, 0..1, from a fixed hash: the same clouds on every visit. */
function valueNoise(x, y, z) {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const fx = x - xi; const fy = y - yi; const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx); const v = fy * fy * (3 - 2 * fy); const w = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => {
    let k = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1440662683);
    k = Math.imul(k ^ (k >>> 13), 1274126177);
    return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(xi, yi, zi), h(xi + 1, yi, zi), u), lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

/** Four octaves of valueNoise, 0..1. */
function fbm(x, y, z) {
  let sum = 0; let amp = 0.5; let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x, y, z);
    norm += amp;
    x *= 2.03; y *= 2.03; z *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
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

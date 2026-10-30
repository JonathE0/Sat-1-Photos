/**
 * A realistic Earth for the Explore page: NASA Blue Marble (day), Black
 * Marble (night lights), a cloud layer, sun glint on water, gentle relief and
 * a physically based single-scattering atmosphere.
 *
 * Frame (same as site/globe/scene.js): three.js is y-up, so ECI/ECEF
 * (x, y, z) is drawn at (x, z, -y); the north pole is +y; one unit is the
 * mean Earth radius. setTime() turns `group` by GMST (group.rotation.y), so
 * anything added to `group` is Earth-fixed; the satellite and its orbit
 * belong in the inertial scene. Sphere UVs line up with an equirectangular
 * map in this frame (u = 0.5 on the prime meridian).
 *
 * Draw order: the surface is opaque; the clouds (r = 1.003, fixed to the
 * ground) and the atmosphere shell (r = 1.015) are transparent, renderOrder
 * 1 and 2. Anything drawn on the ground below r = 1.003 is under the clouds.
 * The materials follow renderer.toneMapping (the look was tuned with
 * ACESFilmicToneMapping, exposure 1); with no tone mapping they roll off
 * highlights themselves.
 *
 *   const earth = createEarth(renderer, { quality: 'high' });
 *   scene.add(earth.group);
 *   earth.setTime(gmst(ms), sunPosition(ms), ms);   // site/globe/astro.js; ms places the Moon
 *   // each frame: earth.update(dt, camera); renderer.render(scene, camera);
 *   await earth.ready;                            // full-resolution maps in
 *
 * Night side: Black Marble city lights (calibrated against CTS-SAT-1's own
 * night frames: warm-white metro cores, amber towns), dimmed and spread under
 * thick cloud, over a faint airglow + moonlight floor (Moon from a low-precision
 * ephemeris, phase-aware) that keeps land and coasts just readable.
 *
 * quality: 'high' 8192-wide maps, 'low' 4096, 'phone' 2048 (all also share a
 * 1024 preview set). Textures load without blocking: the ~0.2 MB preview set
 * first, then the full set; before the previews arrive the globe is a plain
 * dark-ocean sphere with its atmosphere.
 */
import * as THREE from '../globe/vendor/three.module.min.js';
import { moonPosition, moonIlluminated } from './sky/moon.js';

/** Radius of the cloud shell (+0.3%, about 19 km: thick enough to clear the ground mesh). */
const CLOUD_RADIUS = 1.003;
/** Top of the atmosphere shell (+1.5%, about 100 km; the air above is negligible). */
const ATMOSPHERE_RADIUS = 1.015;

const QUALITY = {
  high: { size: 8192, relief: true, segments: [256, 128], shell: [128, 64], steps: 16 },
  low: { size: 4096, relief: true, segments: [160, 80], shell: [96, 48], steps: 12 },
  phone: { size: 2048, relief: false, segments: [128, 64], shell: [96, 48], steps: 10 },
};

// ---------------------------------------------------------------------------
// shaders

const COMMON = /* glsl */ `
  #define PI 3.141592653589793

  // Colour of direct sunlight at the ground relative to a high Sun: the
  // longer air path near the terminator reddens and dims it. mu is the
  // cosine of the solar zenith angle; airmass from Kasten & Young (1989).
  vec3 sunTint(float mu) {
    float m = clamp(mu, 0.0, 1.0);
    float z = degrees(acos(m));
    float airmass = 1.0 / (m + 0.50572 * pow(96.07995 - z, -1.6364));
    return exp(-vec3(0.030, 0.064, 0.140) * (airmass - 1.0));
  }

  // Without renderer tone mapping: identity up to 0.8, then a smooth shoulder.
  vec3 rollOff(vec3 c) {
    #ifdef TONE_MAPPING
      return c;
    #else
      vec3 over = max(c - 0.8, 0.0);
      return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-over / 0.2));
    #endif
  }

  // Cloud map value (black point already removed) to coverage.
  float cloudCover(float c) {
    return smoothstep(0.0, 0.82, c);
  }

  // ---- the night side
  uniform float lightsGain;     // city light at a full-brightness Black Marble pixel
  uniform float lightsCurve;    // map value to radiance exponent (the map is display-coded)
  uniform float nightGlow;      // airglow + starlight on the ground, relative to the Sun at zenith
  uniform float moonLight;      // extra light from a full Moon overhead
  uniform float moonPhase;      // the Moon's brightness now relative to full (0..1)

  // Weights a city-light map value: sodium orange when dim, warm white in the cores.
  vec3 cityLight(float raw) {
    vec3 lamp = mix(vec3(1.0, 0.58, 0.27), vec3(1.0, 0.68, 0.40), smoothstep(0.2, 0.9, raw));
    return lamp * pow(raw, lightsCurve) * lightsGain;
  }

  // What a surface of this albedo reflects of the night sky's light: dark
  // surfaces are lifted a little (eyes and cameras compress at this level),
  // but not so far that they would outshine their own low-Sun daylight, and
  // colour is half gone; slightly blue, as moonlit scenes look.
  vec3 nightGround(vec3 albedo, float moonMu) {
    vec3 a = pow(max(albedo, vec3(1e-5)), vec3(0.6));
    a = mix(vec3(dot(a, vec3(0.2126, 0.7152, 0.0722))), a, 0.5);
    return a * vec3(0.84, 0.90, 1.0) * (nightGlow + moonLight * moonPhase * max(moonMu, 0.0));
  }
`;

const SURFACE_VS = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 moonDir;
  varying vec2 vUv;
  varying vec3 vLocal;     // Earth-fixed unit normal
  varying vec3 vNormalW;   // world normal
  varying vec3 vPosW;
  varying vec3 vSunLocal;  // unit vector to the Sun, Earth-fixed (same at every vertex)
  varying vec3 vMoonLocal; // and to the Moon
  void main() {
    vUv = uv;
    vLocal = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * position);
    mat3 toLocal = transpose(mat3(modelMatrix));
    vSunLocal = normalize(toLocal * sunDir);
    vMoonLocal = normalize(toLocal * moonDir);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SURFACE_FS = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D lightsMap;
  uniform sampler2D cloudMap;
  uniform sampler2D waterMap;
  uniform sampler2D reliefMap;
  uniform vec4 have;            // day, lights, clouds, water loaded (0/1)
  uniform float haveRelief;
  uniform vec2 reliefTexel;     // 1 / relief map size
  uniform vec3 sunDir;          // unit vector to the Sun, world frame
  uniform float glint;          // sun glint strength
  uniform float dusk;           // skylight on the ground just after sunset
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vSunLocal;
  varying vec3 vMoonLocal;

  ${COMMON}

  const float CLOUD_ALT = ${(CLOUD_RADIUS - 1).toFixed(4)};
  // relief map: 0..1 spans about 9 km; exaggerated 3x so ranges read at low sun
  const float RELIEF_SCALE = 3.0 * 9000.0 / 6371000.0;

  void main() {
    // maps are uploaded top row first (flipY = false), so t runs north to south
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec3 n = normalize(vLocal);
    vec3 L = normalize(sunDir);
    vec3 Ll = normalize(vSunLocal);                            // Sun, Earth-fixed
    float mu = dot(n, Ll);                                     // cos solar zenith

    vec3 east = vec3(n.z, 0.0, -n.x);
    float coslat = length(east);
    east = coslat > 1e-4 ? east / coslat : vec3(1.0, 0.0, 0.0);
    vec3 north = cross(n, east);
    coslat = max(coslat, 0.02);

    vec3 albedo = have.x > 0.5 ? texture2D(dayMap, uv).rgb : vec3(0.0016, 0.0042, 0.012);
    float water = have.w > 0.5 ? texture2D(waterMap, uv).r : 0.0;

    // ---- relief: bend the normal along the topography's gradient
    vec3 nb = n;
    if (haveRelief > 0.5) {
      float hE = texture2D(reliefMap, uv + vec2(reliefTexel.x, 0.0)).r;
      float hW = texture2D(reliefMap, uv - vec2(reliefTexel.x, 0.0)).r;
      float hN = texture2D(reliefMap, uv - vec2(0.0, reliefTexel.y)).r;
      float hS = texture2D(reliefMap, uv + vec2(0.0, reliefTexel.y)).r;
      float gE = (hE - hW) * RELIEF_SCALE / (2.0 * reliefTexel.x * 2.0 * PI * coslat);
      float gN = (hN - hS) * RELIEF_SCALE / (2.0 * reliefTexel.y * PI);
      vec2 g = vec2(gE, gN);
      g *= min(1.0, 0.6 / max(length(g), 1e-6));                 // no cliffs steeper than ~30 degrees
      g *= (1.0 - water) * (1.0 - smoothstep(0.94, 0.985, abs(n.y)));   // the map degenerates at the poles
      nb = normalize(n - g.x * east - g.y * north);
    }

    // ---- cloud shadow: the cloud between this point and the Sun
    float shade = 1.0;
    if (have.z > 0.5) {
      vec3 toward = Ll - n * mu;
      float k = CLOUD_ALT / max(mu, 0.12);
      vec2 off = vec2(dot(toward, east) * k / (2.0 * PI * coslat), -dot(toward, north) * k / PI);
      float polar = 1.0 - smoothstep(0.966, 0.995, abs(n.y));   // as the cloud layer
      shade = 1.0 - 0.5 * polar * cloudCover(texture2D(cloudMap, uv + off).r);
    }

    // ---- daylight
    vec3 sun = sunTint(mu);
    float edge = smoothstep(-0.018, 0.012, mu);                // Sun's disc + refraction
    float diffuse = max(dot(nb, Ll), 0.0) * edge;
    vec3 color = albedo * sun * diffuse * shade;

    // ---- sun glint on water: small, sun-coloured
    if (water > 0.0) {
      vec3 N = normalize(vNormalW);
      vec3 V = normalize(cameraPosition - vPosW);
      vec3 H = normalize(L + V);
      float NdotL = max(dot(N, L), 0.0);
      float NdotV = max(dot(N, V), 1e-3);
      float NdotH = max(dot(N, H), 0.0);
      float VdotH = max(dot(V, H), 0.0);
      const float a = 0.07;
      float a2 = a * a;
      float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
      float D = a2 / (PI * d * d);
      float F = 0.02 + 0.98 * pow(1.0 - VdotH, 5.0);
      float kk = a * 0.5;
      float G = NdotL / (NdotL * (1.0 - kk) + kk) * NdotV / (NdotV * (1.0 - kk) + kk);
      float spec = PI * D * F * G / (4.0 * NdotV);
      color += water * spec * sun * edge * shade * glint;
    }

    // ---- twilight: faint skylight on the ground just after sunset
    float twilight = smoothstep(-0.10, -0.005, mu) * (1.0 - smoothstep(-0.005, 0.05, mu));
    color += albedo * vec3(1.0, 0.8, 1.0) * dusk * twilight;

    // ---- night ground: airglow, starlight and the Moon keep the land just
    // readable. Taken as a constant floor (not added, and not faded in), so
    // the fading daylight hands over to it without a darker ring at the
    // terminator, and the day side, which is far brighter, is untouched.
    color = max(color, nightGround(albedo, dot(n, normalize(vMoonLocal))));

    // ---- city lights come on through civil twilight (~8 degree terminator)
    float night = 1.0 - smoothstep(-0.12, -0.01, mu);
    if (have.y > 0.5) color += cityLight(texture2D(lightsMap, uv).r) * night;

    gl_FragColor = vec4(rollOff(color), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const CLOUD_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vLocalY;   // sine of latitude
  void main() {
    vUv = uv;
    vLocalY = normalize(position).y;
    vNormalW = normalize(mat3(modelMatrix) * position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CLOUD_FS = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform sampler2D lightsMap;
  uniform float haveLights;
  uniform vec3 sunDir;
  uniform vec3 moonDir;
  uniform float cloudThrough;   // share of city light a thick cloud deck lets through, diffused
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vLocalY;

  ${COMMON}

  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    float c = texture2D(cloudMap, uv).r;
    vec3 N = normalize(vNormalW);
    // seen edge-on at the limb the shell would stand clear of the ground and
    // the haze; there the air hides cloud anyway, so let it go
    float facing = dot(N, normalize(cameraPosition - vPosW));
    float cover = cloudCover(c) * smoothstep(0.01, 0.12, facing);
    // the source map's last rows are smeared polar data; fade them out
    cover *= 1.0 - smoothstep(0.966, 0.995, abs(vLocalY));
    if (cover < 0.002) discard;
    float mu = dot(N, normalize(sunDir));
    // cloud tops still see the Sun a few degrees past the ground terminator
    float lit = smoothstep(-0.07, 0.05, mu);
    float diffuse = clamp((mu + 0.07) / 1.07, 0.0, 1.0);
    float albedo = mix(0.60, 0.90, smoothstep(0.15, 0.9, c));   // thin cloud is greyer
    vec3 color = albedo * sunTint(mu + 0.07) * diffuse * lit;
    // night: the cloud tops catch airglow and moonlight like the ground does
    color = max(color, 0.8 * nightGround(vec3(albedo), dot(N, normalize(moonDir))));
    // city light below comes through thick cloud dimmed and spread out
    if (haveLights > 0.5) {
      float night = 1.0 - smoothstep(-0.12, -0.01, mu);
      color += cityLight(texture2D(lightsMap, uv, 1.5).r) * cloudThrough * night;
    }
    gl_FragColor = vec4(rollOff(color), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * cover, cover);         // premultiplied
  }
`;

const ATMOSPHERE_VS = /* glsl */ `
  varying vec3 vPosW;
  varying vec3 vCentre;    // the Earth's centre and radius in the world (same at every vertex)
  varying float vScale;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vCentre = modelMatrix[3].xyz;
    vScale = length(modelMatrix[0].xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Single scattering by air (Rayleigh) and haze (Mie) in an exponential
// atmosphere, integrated along the view ray; the optical depth toward the Sun
// comes from Schueler's approximation to the Chapman function. Output is
// premultiplied: in-scattered light, and how much it veils what is behind.
const ATMOSPHERE_FS = /* glsl */ `
  uniform vec3 sunDir;
  uniform float groundHaze;     // scales in-scatter over the disc (1 = physical)
  uniform float haze;           // aerosol amount relative to Bruneton's reference
  // share of the view path's extinction applied to light scattered toward the
  // eye; below 1 it stands in for the multiple scattering this model leaves
  // out, which keeps the low limb white-blue instead of tan
  uniform float viewExt;
  varying vec3 vPosW;
  varying vec3 vCentre;
  varying float vScale;

  #define PI 3.141592653589793
  #define STEPS __STEPS__
  const float RT = ${ATMOSPHERE_RADIUS.toFixed(4)};
  const float HR = 8.0 / 6371.0;           // Rayleigh scale height, Earth radii
  const float HM = 1.2 / 6371.0;           // Mie (aerosol) scale height
  const float LN2 = 0.6931472;
  // sea-level coefficients per Earth radius (Bruneton 2017, x 6371 km)
  const vec3 BR = vec3(36.96, 86.38, 210.9);
  const float BM = 25.46;
  const float BME = 28.26;                 // Mie extinction
  const float G = 0.76;

  // Chapman grazing-incidence function times exp2(-h): X, h in half-heights.
  float chapman(float X, float h, float coschi) {
    float c = sqrt(X + h);
    if (coschi >= 0.0) return c / (c * coschi + 1.0) * exp2(-h);
    float x0 = sqrt(1.0 - coschi * coschi) * (X + h);
    float c0 = sqrt(x0);
    return 2.0 * c0 * exp2(X - x0) - c / (1.0 - c * coschi) * exp2(-h);
  }

  vec3 rollOff(vec3 c) {
    #ifdef TONE_MAPPING
      return c;
    #else
      vec3 over = max(c - 0.8, 0.0);
      return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-over / 0.2));
    #endif
  }

  void main() {
    vec3 ro = (cameraPosition - vCentre) / vScale;
    vec3 rd = normalize(vPosW - cameraPosition);
    vec3 L = normalize(sunDir);

    float b = dot(ro, rd);
    float disc = b * b - (dot(ro, ro) - RT * RT);
    if (disc <= 0.0) discard;
    float sq = sqrt(disc);
    float t0 = max(-b - sq, 0.0);
    float t1 = -b + sq;
    float dg = b * b - (dot(ro, ro) - 1.0);
    // over the disc the haze is scaled by groundHaze, easing back to full
    // strength toward the horizon so ground and sky meet without a step
    float hazeScale = 1.0;
    if (dg > 0.0) {
      float tg = -b - sqrt(dg);
      if (tg > 0.0) {
        t1 = min(t1, tg);
        float graze = -dot(normalize(ro + rd * tg), rd);   // cos of the view angle at the ground
        hazeScale = mix(1.0, groundHaze, smoothstep(0.0, 0.35, graze));
      }
    }
    if (t1 <= t0) discard;

    float ds = (t1 - t0) / float(STEPS);
    float nu = dot(rd, L);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + nu * nu);
    float g2 = G * G;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + nu * nu)) /
                   ((2.0 + g2) * pow(1.0 + g2 - 2.0 * G * nu, 1.5));

    const float XR = 1.0 / (HR * LN2);
    const float XM = 1.0 / (HM * LN2);
    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    float viewR = 0.0;
    float viewM = 0.0;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
      float r = length(p);
      float h = max(r - 1.0, 0.0);
      float dR = exp(-h / HR) * ds;
      float dM = haze * exp(-h / HM) * ds;
      viewR += 0.5 * dR;
      viewM += 0.5 * dM;
      float coschi = dot(p, L) / r;
      // lit unless the Earth is between this point and the Sun
      if (!(coschi < 0.0 && r * r * (1.0 - coschi * coschi) < 1.0)) {
        float sunR = HR * chapman(XR, h / (HR * LN2), coschi);
        float sunM = haze * HM * chapman(XM, h / (HM * LN2), coschi);
        vec3 T = exp(-(BR * (viewExt * viewR + sunR) + BME * (viewExt * viewM + sunM)));
        sumR += T * dR;
        sumM += T * dM;
      }
      viewR += 0.5 * dR;
      viewM += 0.5 * dM;
    }
    // Sun irradiance pi: a white Lambertian ground under a zenith Sun reads 1.0
    vec3 inscatter = PI * (BR * phaseR * sumR + BM * phaseM * sumM);
    vec3 transmit = exp(-(BR * viewR + BME * viewM));
    inscatter *= hazeScale;
    float veil = 1.0 - dot(transmit, vec3(1.0 / 3.0));
    gl_FragColor = vec4(rollOff(inscatter), veil);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// texture loading

/** Fetch and decode an image, off the main thread where the browser can. */
async function loadImage(url, signal, priority = 'auto') {
  const res = await fetch(url, { signal, priority, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      // fall back to an <img> below
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ quality?: 'high' | 'low' | 'phone', textureBase?: string | URL }} [options]
 */
export function createEarth(renderer, { quality = 'high', textureBase } = {}) {
  const q = QUALITY[quality] || QUALITY.high;
  const base = textureBase
    ? new URL(String(textureBase).replace(/\/?$/, '/'), document.baseURI)
    : new URL('./textures/', import.meta.url);
  const maxSize = renderer.capabilities.maxTextureSize || 4096;
  const size = maxSize >= q.size ? q.size : maxSize >= 4096 ? 4096 : 2048;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const abort = new AbortController();
  let disposed = false;

  const sunDir = new THREE.Vector3(1, 0, 0);
  const moonDir = new THREE.Vector3(-1, 0, 0);

  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  // ---- materials
  // night-side values shared by the ground and the clouds (see COMMON)
  const night = {
    lightsGain: { value: 2.0 },
    lightsCurve: { value: 1.3 },
    nightGlow: { value: 0.03 },
    moonLight: { value: 0.02 },
    moonPhase: { value: 0 },
    moonDir: { value: moonDir },
  };
  const surfaceUniforms = {
    ...night,
    dayMap: { value: blank },
    lightsMap: { value: blank },
    cloudMap: { value: blank },
    waterMap: { value: blank },
    reliefMap: { value: blank },
    have: { value: new THREE.Vector4(0, 0, 0, 0) },
    haveRelief: { value: 0 },
    reliefTexel: { value: new THREE.Vector2(1 / 4096, 1 / 2048) },
    sunDir: { value: sunDir },
    glint: { value: 0.18 },
    dusk: { value: 0.02 },
  };
  const surfaceMaterial = new THREE.ShaderMaterial({
    name: 'EarthSurface',
    uniforms: surfaceUniforms,
    vertexShader: SURFACE_VS,
    fragmentShader: SURFACE_FS,
  });

  const premultiplied = {
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  };

  const cloudUniforms = {
    ...night,
    cloudMap: { value: blank },
    lightsMap: { value: blank },
    haveLights: { value: 0 },
    cloudThrough: { value: 0.2 },
    sunDir: { value: sunDir },
  };
  const cloudMaterial = new THREE.ShaderMaterial({
    name: 'EarthClouds',
    uniforms: cloudUniforms,
    vertexShader: CLOUD_VS,
    fragmentShader: CLOUD_FS,
    ...premultiplied,
    // keeps the shell in front of the ground when the depth buffer is coarse
    // (camera far away with a small near plane)
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  const atmosphereUniforms = {
    sunDir: { value: sunDir },
    groundHaze: { value: 0.75 },
    haze: { value: 0.3 },
    viewExt: { value: 0.4 },
  };
  const atmosphereMaterial = new THREE.ShaderMaterial({
    name: 'EarthAtmosphere',
    uniforms: atmosphereUniforms,
    vertexShader: ATMOSPHERE_VS,
    fragmentShader: ATMOSPHERE_FS.replace('__STEPS__', String(q.steps)),
    side: THREE.FrontSide,
    ...premultiplied,
  });

  // ---- meshes
  const group = new THREE.Group();
  group.name = 'Earth';

  const surfaceGeometry = new THREE.SphereGeometry(1, q.segments[0], q.segments[1]);
  const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
  surface.name = 'EarthSurface';
  group.add(surface);

  const cloudGeometry = new THREE.SphereGeometry(CLOUD_RADIUS, q.segments[0], q.segments[1]);
  const clouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
  clouds.name = 'EarthClouds';
  clouds.renderOrder = 1;
  clouds.visible = false;
  group.add(clouds);

  const atmosphereGeometry = new THREE.SphereGeometry(ATMOSPHERE_RADIUS, q.shell[0], q.shell[1]);
  const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
  atmosphere.name = 'EarthAtmosphere';
  atmosphere.renderOrder = 2;
  group.add(atmosphere);

  // ---- textures
  const current = {}; // slot -> { texture, tier }
  const PREVIEW = 1;
  const FULL = 2;

  function install(slot, image, tier) {
    const prev = current[slot];
    if (prev && prev.tier > tier) {
      image.close?.();
      return;
    }
    const tex = new THREE.Texture(image);
    tex.name = `earth-${slot}`;
    tex.flipY = false;
    tex.colorSpace = slot === 'day' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (slot !== 'day') tex.format = THREE.RedFormat; // one channel: a quarter of the memory
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = slot === 'relief' ? 1 : anisotropy;
    tex.needsUpdate = true;
    renderer.initTexture(tex);
    const { width, height } = image;
    // the pixels now live on the GPU; free the decoded copy
    image.close?.();
    current[slot] = { texture: tex, tier };
    if (prev) prev.texture.dispose();

    const have = surfaceUniforms.have.value;
    if (slot === 'day') {
      surfaceUniforms.dayMap.value = tex;
      have.x = 1;
    } else if (slot === 'lights') {
      surfaceUniforms.lightsMap.value = tex;
      cloudUniforms.lightsMap.value = tex;
      cloudUniforms.haveLights.value = 1;
      have.y = 1;
    } else if (slot === 'clouds') {
      surfaceUniforms.cloudMap.value = tex;
      cloudUniforms.cloudMap.value = tex;
      have.z = 1;
      clouds.visible = true;
    } else if (slot === 'water') {
      surfaceUniforms.waterMap.value = tex;
      have.w = 1;
    } else if (slot === 'relief') {
      surfaceUniforms.reliefMap.value = tex;
      surfaceUniforms.reliefTexel.value.set(1 / (width || 4096), 1 / (height || 2048));
      surfaceUniforms.haveRelief.value = 1;
    }
  }

  // Uploads run one per task (an 8192 map takes ~100 ms of main thread), so
  // the page can paint between them.
  let uploads = Promise.resolve();
  function queueInstall(slot, image, tier) {
    uploads = uploads.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            try {
              if (disposed) image.close?.();
              else install(slot, image, tier);
            } catch (err) {
              console.warn(`Earth: could not upload the ${slot} map`, err);
            }
            resolve();
          }, 0);
        }),
    );
    return uploads;
  }

  function load(slot, file, tier, priority) {
    return loadImage(new URL(file, base).href, abort.signal, priority).then(
      (image) => queueInstall(slot, image, tier).then(() => true),
      (err) => {
        if (!disposed && err?.name !== 'AbortError') console.warn(`Earth: could not load ${file}`, err);
        return false;
      },
    );
  }

  function loadAll() {
    // previews first: small and quick, so the globe looks right within moments
    const previews = Promise.all([
      load('day', 'earth-day-1024.webp', PREVIEW, 'high'),
      load('clouds', 'earth-clouds-1024.jpg', PREVIEW, 'high'),
      load('lights', 'earth-lights-1024.jpg', PREVIEW, 'high'),
    ]);
    const full = previews.then(() =>
      Promise.all([
        load('day', `earth-day-${size}.webp`, FULL, 'high'),
        load('clouds', `earth-clouds-${size}.jpg`, FULL, 'auto'),
        load('lights', `earth-lights-${size}.jpg`, FULL, 'auto'),
        load('water', `earth-water-${size}.png`, FULL, 'auto'),
      ]),
    );
    if (q.relief) full.then(() => load('relief', 'earth-relief-4096.jpg', FULL, 'low'));
    return full;
  }

  const ready = loadAll().then(() => undefined);

  // a lost-and-restored WebGL context drops every texture: fetch them again
  const canvas = renderer.domElement;
  const onRestored = () => {
    for (const slot of Object.keys(current)) {
      current[slot].texture.dispose();
      delete current[slot];
    }
    surfaceUniforms.have.value.set(0, 0, 0, 0);
    surfaceUniforms.haveRelief.value = 0;
    cloudUniforms.haveLights.value = 0;
    clouds.visible = false;
    loadAll();
  };
  canvas?.addEventListener?.('webglcontextrestored', onRestored);

  // ---- per-frame
  const camPos = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const scale = new THREE.Vector3();

  /**
   * gmstAngle in radians; sunEci a vector toward the Sun in ECI (any length).
   * ms (optional, default now) is only used to place the Moon for moonlight,
   * which changes slowly, so leaving it out costs little.
   */
  function setTime(gmstAngle, sunEci, ms = Date.now()) {
    group.rotation.y = gmstAngle;
    sunDir.set(sunEci.x, sunEci.z, -sunEci.y).normalize();
    // the same Moon the sky draws (sky/moon.js)
    const moon = moonPosition(ms);
    moonDir.set(moon.x, moon.z, -moon.y);
    // its brightness falls much faster than the lit fraction (a half Moon gives ~1/10 of full)
    night.moonPhase.value = moonIlluminated(moon, sunEci) ** 3;
  }

  // The clouds are fixed to the ground and the Sun moves only through
  // setTime, so per frame this only has to see where the camera is.
  function update(dtSeconds, camera) {
    if (!camera) return;
    group.updateWorldMatrix(true, false);
    centre.setFromMatrixPosition(group.matrixWorld);
    scale.setFromMatrixScale(group.matrixWorld);
    camera.getWorldPosition(camPos);
    // inside the shell its front faces are behind the camera: draw the back faces
    const inside = camPos.distanceTo(centre) < ATMOSPHERE_RADIUS * scale.x * 1.0005;
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    if (atmosphereMaterial.side !== side) {
      atmosphereMaterial.side = side;
      atmosphereMaterial.needsUpdate = true;
    }
  }

  function dispose() {
    disposed = true;
    abort.abort();
    canvas?.removeEventListener?.('webglcontextrestored', onRestored);
    group.removeFromParent();
    for (const slot of Object.keys(current)) current[slot].texture.dispose();
    blank.dispose();
    surfaceGeometry.dispose();
    cloudGeometry.dispose();
    atmosphereGeometry.dispose();
    surfaceMaterial.dispose();
    cloudMaterial.dispose();
    atmosphereMaterial.dispose();
  }

  return { group, setTime, update, ready, dispose };
}

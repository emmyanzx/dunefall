import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import "./style.css";
import { buildBattlefieldTerrain, getTerrainHeight, getTerrainNormal } from "./terrain";
import { createDesertSkyTexture, createSoftGlowTexture } from "./textures";
import {
  buildAllyCar,
  buildAllyDrone,
  buildArtilleryPylon,
  buildBossMech,
  buildConvoyHauler,
  buildDangerRing,
  buildEnemyMech,
  buildEnergyCore,
  buildMissilePod,
  buildMissionCore,
  buildPlayerMech,
  buildRelayTower,
  type EnemyRig,
} from "./models";
import { DunefallAudio } from "./audio";
import {
  CHAPTERS,
  type ChapterDef,
  type RadioMessage,
  type TacticalChoiceId,
  applyTacticalChoice,
  computeCampaignRank,
  createFreshCampaignState,
  getSpeakerPortraitSvg,
  loadCampaignSave,
  persistCampaignSave,
  validateCampaignData,
} from "./story";

// ── 1. Renderer, Scene, Smart Integrated-GPU Auto-Detection & Bloom Pipeline ─
const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});

// Detect integrated GPUs (e.g. Intel UHD 620) or <=8GB RAM so the game boots silky-smooth with zero hitching!
function detectIntegratedGPU(): boolean {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpuStr = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
    if (/intel|uhd|hd graphics|iris|swiftshader|llvmpipe|basic render/i.test(gpuStr)) return true;
    if (mem <= 8) return true;
  } catch {
    return true;
  }
  return false;
}

let ecoMode = detectIntegratedGPU();
const initDpr = ecoMode ? 1.0 : Math.min(window.devicePixelRatio, 1.5);
renderer.setPixelRatio(initDpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
// Dusty mauve-amber desert storm atmospheric fog
scene.fog = new THREE.FogExp2(0x7c6866, 0.0092);

canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
});

try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.52;
  pmrem.dispose();
} catch {
  // Fallback cleanly if GPU driver restricts PMREM FBOs
}

const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.25, 320);

// Lazy-init Bloom postprocessing ONLY when High PBR mode is enabled (saves ~60MB VRAM on Eco / integrated GPUs!)
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
function ensureComposer() {
  if (composer) return composer;
  const pr = Math.min(window.devicePixelRatio, 1.5);
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(pr);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
    0.34,
    0.58,
    0.82
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  return composer;
}
if (!ecoMode) ensureComposer();

const studioControls = new OrbitControls(camera, renderer.domElement);
studioControls.enableDamping = true;
studioControls.dampingFactor = 0.07;
studioControls.maxPolarAngle = Math.PI * 0.48;
studioControls.minDistance = 5;
studioControls.maxDistance = 42;
studioControls.enabled = false;

// Sky dome
const skyMat = new THREE.MeshBasicMaterial({ map: createDesertSkyTexture(), side: THREE.BackSide, fog: false });
scene.add(new THREE.Mesh(new THREE.SphereGeometry(230, 24, 16), skyMat));

// Low-angle warm desert key sun + cool lavender-slate overcast fill (long dramatic desert shadows)
const hemi = new THREE.HemisphereLight(0xa99ba6, 0x6e4a30, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffcb94, 3.1);
sun.position.set(-48, 28, -32);
sun.castShadow = true;
const initShadowRes = ecoMode ? 1024 : 2048;
sun.shadow.mapSize.set(initShadowRes, initShadowRes);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
const sc = sun.shadow.camera;
sc.near = 4;
sc.far = 160;
sc.left = -46;
sc.right = 46;
sc.top = 46;
sc.bottom = -46;
scene.add(sun, sun.target);

// ── 2. Battlefield Terrain, Mesas & Craters ──────────────────────────────────
const terrain = buildBattlefieldTerrain(scene);
const audio = new DunefallAudio();
const glowTex = createSoftGlowTexture();

// ── 3. Weapon Styles (G / H / J / K / L) ─────────────────────────────────────
type WeaponDef = {
  id: string;
  name: string;
  cooldown: number;
  damage: number;
  speed: number;
  heat: number;
  color: number;
  dual: boolean;
  splash: number;
  spread: number;
  trauma: number;
  length: number;
};

const WEAPONS: WeaponDef[] = [
  { id: "G", name: "VANGUARD", cooldown: 0.11, damage: 11, speed: 125, heat: 3.4, color: 0xffd27a, dual: false, splash: 0, spread: 0.018, trauma: 0.06, length: 2.2 },
  { id: "H", name: "BASTION", cooldown: 0.24, damage: 24, speed: 115, heat: 5.2, color: 0xf59e0b, dual: false, splash: 0, spread: 0.012, trauma: 0.12, length: 2.8 },
  { id: "J", name: "SUNLANCE", cooldown: 0.14, damage: 12, speed: 138, heat: 4.8, color: 0x7dd3fc, dual: true, splash: 0, spread: 0.022, trauma: 0.09, length: 2.5 },
  { id: "K", name: "RAILBREAKER", cooldown: 0.62, damage: 64, speed: 210, heat: 16.5, color: 0xfef08a, dual: false, splash: 2.4, spread: 0.004, trauma: 0.34, length: 7.5 },
  { id: "L", name: "CRATERFALL", cooldown: 0.78, damage: 52, speed: 78, heat: 18.0, color: 0xfb923c, dual: false, splash: 7.5, spread: 0.015, trauma: 0.38, length: 2.0 },
];

// ── 4. Player Rig & Battlefield State ────────────────────────────────────────
const playerRig = buildPlayerMech();
scene.add(playerRig.root);

const player = {
  x: 0,
  z: 12,
  vx: 0,
  vz: 0,
  yaw: 0, // 0 = facing -Z (north toward dunes!)
  camYaw: 0,
  camPitch: 0.42, // Elevated tactical view over the desert dunes
  camZoom: 16.5,
  morph: 0, // 0 = mech, 1 = car
  targetMorph: 0,
  siege: 0,
  stance: "strider" as "strider" | "siege" | "car",
  weaponSlot: 0,
  hull: 140,
  maxHull: 140,
  plate: 100,
  maxPlate: 100,
  heat: 0,
  overheated: false,
  cells: 6,
  maxCells: 8,
  cellRegen: 0,
  fireCd: 0,
  missileCd: 0,
  squadCd: 0,
  podCd: 0,
  dashTimer: 0,
  dashDirX: 0,
  dashDirZ: 0,
  walkCycle: 0,
  barrelSide: 0 as 0 | 1,
  recoilL: 0,
  recoilR: 0,
  shots: 0,
  kills: 0,
  score: 0,
  cores: 0,
  coresNeeded: 4,
  tier: 1,
  wave: 1,
  upRail: 1,
  upPods: 1,
  upPlate: 1,
  trauma: 0,
  shakeMult: 1.0,
  hitStop: 0,
  studioMode: false,
  freezeEnemies: false,
  paused: false,
};

// ── 5. Entities: Enemies, Allies, Pods, Cores, Projectiles, Particles, Debris ─
type Enemy = {
  id: number;
  rig: EnemyRig;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  heavy: boolean;
  isBoss?: boolean;
  bossPhase?: 1 | 2;
  barrageCd?: number;
  solarCore?: THREE.Mesh;
  overdriveAura?: THREE.Mesh;
  fireCd: number;
  walkCycle: number;
  strafeDir: number;
  hitFlash: number;
  hpEl: HTMLDivElement;
  fillEl: HTMLDivElement;
};

type MissionCore = {
  rig: ReturnType<typeof buildMissionCore>;
  x: number;
  z: number;
  bob: number;
  label: string;
  wpEl: HTMLDivElement;
};

type RelayTower = {
  rig: ReturnType<typeof buildRelayTower>;
  x: number;
  z: number;
  radius: number;
  progress: number; // 0..100
  captured: boolean;
  label: string;
  wpEl: HTMLDivElement;
};

type ConvoyHauler = {
  rig: ReturnType<typeof buildConvoyHauler>;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  hp: number;
  maxHp: number;
  waypointIdx: number;
  waypoints: [number, number][];
  fireCd: number;
  ambushSpawned: boolean;
  wpEl: HTMLDivElement;
};

type ArtilleryPylon = {
  id: number;
  rig: ReturnType<typeof buildArtilleryPylon>;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  fireCd: number;
  hitFlash: number;
  label: string;
  hpEl: HTMLDivElement;
  fillEl: HTMLDivElement;
  wpEl: HTMLDivElement;
};

type DangerRing = {
  rig: ReturnType<typeof buildDangerRing>;
  x: number;
  z: number;
  radius: number;
  timer: number;
  maxTime: number;
  damage: number;
};

type AllyCar = {
  rig: ReturnType<typeof buildAllyCar>;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  fireCd: number;
  orbitAngle: number;
  life: number;
};

type AllyDrone = {
  mesh: THREE.Group;
  x: number;
  y: number;
  z: number;
  orbitAngle: number;
  fireCd: number;
  life: number;
};

type MissilePod = {
  rig: ReturnType<typeof buildMissilePod>;
  x: number;
  z: number;
  fireCd: number;
  life: number;
};

type EnergyCore = {
  rig: ReturnType<typeof buildEnergyCore>;
  x: number;
  z: number;
  bob: number;
};

type Projectile = {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  damage: number;
  splash: number;
  friendly: boolean;
  homingTarget: Enemy | null;
  isMissile: boolean;
  gravity: number;
  life: number;
};

type Particle = {
  sprite: THREE.Sprite;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
};

type DebrisChunk = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  life: number;
};

const enemies: Enemy[] = [];
const allyCars: AllyCar[] = [];
const allyDrones: AllyDrone[] = [];
const missilePods: MissilePod[] = [];
const energyCores: EnergyCore[] = [];
const projectiles: Projectile[] = [];
const particles: Particle[] = [];
const debris: DebrisChunk[] = [];

// Story Mode dynamic entities
const missionCores: MissionCore[] = [];
const relayTowers: RelayTower[] = [];
let convoy: ConvoyHauler | null = null;
const artilleryPylons: ArtilleryPylon[] = [];
const dangerRings: DangerRing[] = [];

let nextEnemyId = 1;
let nextPylonId = 1;
let lockedEnemyId: number | null = null;

// Story Mode & Campaign State
let gameMode: "story" | "endless" = "story";
let menuOpen = true;
let campaignSave = loadCampaignSave();
let selectedLaunchChapter = campaignSave.unlockedChapter;
let campaign = createFreshCampaignState(0);
let storyPhase = 0; // chapter sub-stage (0 = opening, 1 = mid-mission twist, 2 = cleared)
let storyKillsNeeded = 0;
let storyKillsCount = 0;
let storyCoresCollected = 0;
let storyCoresTotal = 0;
let storyReinforceTimer = 0;
let chapterTransitionTimer = 0;
let pendingNextChapterIdx: number | null = null;
let pendingVictory = false;
let pendingBriefingChoice: TacticalChoiceId | null = null;

// Radio Comms Queue (non-blocking diegetic headset)
const radioQueue: RadioMessage[] = [];
let activeRadio: RadioMessage | null = null;
let radioTimer = 0;

// Validate campaign data graph once at startup
const storyErrs = validateCampaignData();
if (storyErrs.length > 0) console.warn("Story validation warnings:", storyErrs);

// ── 6. Zero-GC Pre-Allocated VFX, Projectile & Debris Pools (NO mid-fight GC or shader stalls!) ──
const tracerGeo = new THREE.BoxGeometry(0.16, 0.16, 1.0);
const missileGeo = new THREE.CylinderGeometry(0.1, 0.14, 1.15, 6);
missileGeo.rotateX(Math.PI / 2);
const debrisGeo = new THREE.DodecahedronGeometry(0.32, 0);
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x201d22, roughness: 0.65, metalness: 0.7 });

// Cached projectile materials by color hex (never allocated/disposed per shot!)
const projMatCache = new Map<number, THREE.MeshBasicMaterial>();
function getProjMat(hex: number) {
  let m = projMatCache.get(hex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: hex });
    projMatCache.set(hex, m);
  }
  return m;
}
// Pre-warm all projectile colors
for (const c of [0xffd27a, 0xf59e0b, 0x7dd3fc, 0xfef08a, 0xfb923c, 0xffb347, 0xff4040, 0xff6b35, 0x4ade80, 0x86efac]) {
  getProjMat(c);
}

// Pre-allocated Particle Pools (90 additive sparks/flashes + 32 normal dust puffs = 0 runtime allocations!)
const addSpritePool: THREE.Sprite[] = [];
const normSpritePool: THREE.Sprite[] = [];
for (let i = 0; i < 90; i++) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  s.visible = false;
  scene.add(s);
  addSpritePool.push(s);
}
for (let i = 0; i < 32; i++) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xa68462,
      transparent: true,
      opacity: 0.85,
      blending: THREE.NormalBlending,
      depthWrite: false,
    })
  );
  s.visible = false;
  scene.add(s);
  normSpritePool.push(s);
}

// Pre-allocated Projectile Mesh Pools (64 tracers + 24 missiles)
const tracerPool: THREE.Mesh[] = [];
const missilePool: THREE.Mesh[] = [];
for (let i = 0; i < 64; i++) {
  const m = new THREE.Mesh(tracerGeo, getProjMat(0xffd27a));
  m.visible = false;
  scene.add(m);
  tracerPool.push(m);
}
for (let i = 0; i < 24; i++) {
  const m = new THREE.Mesh(missileGeo, getProjMat(0xffb347));
  m.visible = false;
  scene.add(m);
  missilePool.push(m);
}

// Pre-allocated Debris Chunk Pool (32 chunks, no shadow-casting overhead on tiny bits!)
const debrisPool: THREE.Mesh[] = [];
for (let i = 0; i < 32; i++) {
  const m = new THREE.Mesh(debrisGeo, debrisMat);
  m.visible = false;
  scene.add(m);
  debrisPool.push(m);
}

function releaseParticle(pt: Particle) {
  pt.sprite.visible = false;
  if (pt.sprite.material.blending === THREE.AdditiveBlending) addSpritePool.push(pt.sprite);
  else normSpritePool.push(pt.sprite);
}

function releaseProjectile(pr: Projectile) {
  pr.mesh.visible = false;
  if (pr.isMissile) missilePool.push(pr.mesh);
  else tracerPool.push(pr.mesh);
}

function releaseDebris(db: DebrisChunk) {
  db.mesh.visible = false;
  debrisPool.push(db.mesh);
}

function spawnParticle(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  colorHex: number,
  startScale: number,
  endScale: number,
  life: number,
  gravity = 0,
  additive = true
) {
  const pool = additive ? addSpritePool : normSpritePool;
  let sprite = pool.pop();
  if (!sprite) {
    // Recycle oldest active particle of matching blending type
    const idx = particles.findIndex(
      (pt) => (pt.sprite.material.blending === THREE.AdditiveBlending) === additive
    );
    if (idx === -1) return;
    sprite = particles.splice(idx, 1)[0].sprite;
  }
  sprite.material.color.setHex(colorHex);
  sprite.material.opacity = 0.92;
  sprite.position.set(x, y, z);
  sprite.scale.set(startScale, startScale, 1);
  sprite.visible = true;
  particles.push({ sprite, vx, vy, vz, gravity, life, maxLife: life, startScale, endScale });
}

function spawnSparkBurst(x: number, y: number, z: number, count: number, colorHex = 0xffcf70, speed = 12) {
  const n = ecoMode ? Math.max(3, Math.ceil(count * 0.6)) : count;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = speed * (0.4 + Math.random() * 0.9);
    spawnParticle(
      x,
      y,
      z,
      Math.cos(a) * sp,
      2 + Math.random() * sp * 0.75,
      Math.sin(a) * sp,
      colorHex,
      0.55,
      0.12,
      0.28 + Math.random() * 0.35,
      -18,
      true
    );
  }
}

function spawnExplosion(x: number, y: number, z: number, big = false) {
  audio.playExplosion(big);
  terrain.spawnCrater(x, z, big ? 4.4 : 2.6);
  player.trauma = Math.min(1, player.trauma + (big ? 0.52 : 0.22));

  // Core fireball flash
  spawnParticle(x, y + 0.8, z, 0, 1.5, 0, 0xffe49e, big ? 4.5 : 2.4, big ? 9.5 : 5.2, 0.32, 0, true);
  spawnParticle(x, y + 0.6, z, 0, 2.2, 0, 0xff6b2b, big ? 3.2 : 1.8, big ? 7.8 : 4.2, 0.48, 0, true);

  // Dusty desert shockwave plume
  const dustCount = big ? 6 : 3;
  for (let i = 0; i < dustCount; i++) {
    const a = (i / dustCount) * Math.PI * 2 + Math.random() * 0.5;
    spawnParticle(
      x + Math.cos(a) * 1.2,
      y + 0.5,
      z + Math.sin(a) * 1.2,
      Math.cos(a) * (big ? 5.5 : 3.2),
      2.2 + Math.random() * 2.5,
      Math.sin(a) * (big ? 5.5 : 3.2),
      0x8c7056,
      big ? 2.4 : 1.5,
      big ? 7.2 : 4.2,
      0.95 + Math.random() * 0.4,
      -1.2,
      false
    );
  }

  spawnSparkBurst(x, y + 0.9, z, big ? 16 : 8, 0xffc864, big ? 18 : 11);

  // Flying charred metal debris chunks from pre-allocated pool!
  const chunks = big ? 8 : 3;
  for (let i = 0; i < chunks; i++) {
    let m = debrisPool.pop();
    if (!m) {
      if (debris.length === 0) break;
      m = debris.shift()!.mesh;
    }
    m.position.set(x, y + 1.0, z);
    m.scale.set(0.6 + Math.random() * 1.1, 0.5 + Math.random() * 0.9, 0.7 + Math.random() * 1.1);
    m.visible = true;
    const a = Math.random() * Math.PI * 2;
    const sp = (big ? 12 : 7) * (0.4 + Math.random() * 0.8);
    debris.push({
      mesh: m,
      vx: Math.cos(a) * sp,
      vy: 6 + Math.random() * (big ? 11 : 6),
      vz: Math.sin(a) * sp,
      rx: (Math.random() - 0.5) * 9,
      ry: (Math.random() - 0.5) * 9,
      life: 4.5 + Math.random() * 2.0,
    });
  }
}

function spawnProjectile(opts: {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speed: number;
  damage: number;
  color: number;
  friendly: boolean;
  splash?: number;
  length?: number;
  isMissile?: boolean;
  homingTarget?: Enemy | null;
  gravity?: number;
}) {
  const isMissile = opts.isMissile ?? false;
  const pool = isMissile ? missilePool : tracerPool;
  let mesh = pool.pop();
  if (!mesh) {
    const idx = projectiles.findIndex((pr) => pr.isMissile === isMissile);
    if (idx === -1) return;
    mesh = projectiles.splice(idx, 1)[0].mesh;
  }
  mesh.material = getProjMat(opts.color);
  if (!isMissile) mesh.scale.set(1, 1, opts.length ?? 2.4);
  else mesh.scale.set(1, 1, 1);
  mesh.position.set(opts.x, opts.y, opts.z);
  mesh.lookAt(opts.x + opts.dirX, opts.y + opts.dirY, opts.z + opts.dirZ);
  mesh.visible = true;

  projectiles.push({
    mesh,
    x: opts.x,
    y: opts.y,
    z: opts.z,
    vx: opts.dirX * opts.speed,
    vy: opts.dirY * opts.speed,
    vz: opts.dirZ * opts.speed,
    damage: opts.damage,
    splash: opts.splash ?? 0,
    friendly: opts.friendly,
    homingTarget: opts.homingTarget ?? null,
    isMissile,
    gravity: opts.gravity ?? 0,
    life: isMissile ? 4.2 : 2.2,
  });
}

// ── 7. HUD Element References & Helpers ──────────────────────────────────────
const enemyBarsEl = document.getElementById("enemy-bars")!;
const worldWaypointsEl = document.getElementById("world-waypoints")!;
const reticleEl = document.getElementById("reticle")!;
const waveNumEl = document.getElementById("wave-num")!;
const waveTitleEl = document.getElementById("wave-title")!;
const waveSubEl = document.getElementById("wave-sub")!;
const calloutEl = document.getElementById("callout")!;
const plateFillEl = document.getElementById("plate-fill")!;
const plateValEl = document.getElementById("plate-val")!;
const heatFillEl = document.getElementById("heat-fill")!;
const heatValEl = document.getElementById("heat-val")!;
const cellsGridEl = document.getElementById("cells-grid")!;
const cellsValEl = document.getElementById("cells-val")!;
const hullFillEl = document.getElementById("hull-fill")!;
const hullValEl = document.getElementById("hull-val")!;
const shotsValEl = document.getElementById("shots-val")!;
const tierNumEl = document.getElementById("tier-num")!;
const coresValEl = document.getElementById("cores-val")!;
const killsValEl = document.getElementById("kills-val")!;
const scoreValEl = document.getElementById("score-val")!;
const squadSubEl = document.getElementById("squad-sub")!;
const podSubEl = document.getElementById("pod-sub")!;
const btnSquad = document.getElementById("btn-squad")!;
const btnPod = document.getElementById("btn-pod")!;
const btnDrive = document.getElementById("btn-drive")!;
const btnStance = document.getElementById("btn-stance")!;
const btnStudio = document.getElementById("btn-studio")!;
const perfBadgeEl = document.getElementById("perf-badge")!;
const aimHintEl = document.getElementById("aim-hint")!;
const settingsModal = document.getElementById("settings-modal")!;

// Story Mode HUD & Modal Refs
const objectiveBarEl = document.getElementById("objective-bar")!;
const objCodeEl = document.getElementById("obj-code")!;
const objCounterEl = document.getElementById("obj-counter")!;
const objTextEl = document.getElementById("obj-text")!;
const objFillEl = document.getElementById("obj-fill")!;
const objSubEl = document.getElementById("obj-sub")!;
const bossBarEl = document.getElementById("boss-bar")!;
const bossPhaseEl = document.getElementById("boss-phase")!;
const bossFillEl = document.getElementById("boss-fill")!;
const radioBoxEl = document.getElementById("radio-box")!;
const radioPortraitEl = document.getElementById("radio-portrait")!;
const radioCallsignEl = document.getElementById("radio-callsign")!;
const radioRoleEl = document.getElementById("radio-role")!;
const radioTextEl = document.getElementById("radio-text")!;
const modeModal = document.getElementById("mode-modal")!;
const chapterPillsEl = document.getElementById("chapter-pills")!;
const storyProgressBadgeEl = document.getElementById("story-progress-badge")!;
const btnLaunchStory = document.getElementById("btn-launch-story")!;
const btnLaunchEndless = document.getElementById("btn-launch-endless")!;
const briefingModal = document.getElementById("briefing-modal")!;
const briefKickerEl = document.getElementById("brief-kicker")!;
const briefSectorEl = document.getElementById("brief-sector")!;
const briefSummaryEl = document.getElementById("brief-summary")!;
const choiceSectionEl = document.getElementById("choice-section")!;
const choiceGridEl = document.getElementById("choice-grid")!;
const nextOpCodeEl = document.getElementById("next-op-code")!;
const nextOpTitleEl = document.getElementById("next-op-title")!;
const nextOpBriefEl = document.getElementById("next-op-brief")!;
const nextOpHintEl = document.getElementById("next-op-hint")!;
const btnDeployNext = document.getElementById("btn-deploy-next")!;
const victoryModal = document.getElementById("victory-modal")!;
const vicRankLetterEl = document.getElementById("vic-rank-letter")!;
const vicScoreEl = document.getElementById("vic-score")!;
const vicTimeEl = document.getElementById("vic-time")!;
const vicKillsEl = document.getElementById("vic-kills")!;
const vicRankEl = document.getElementById("vic-rank")!;
const goTitleEl = document.getElementById("go-title")!;
const goWaveLblEl = document.getElementById("go-wave-lbl")!;
const btnPlayAgain = document.getElementById("btn-play-again")!;

function rebuildCellPips() {
  cellsGridEl.innerHTML = "";
  for (let i = 0; i < player.maxCells; i++) {
    const pip = document.createElement("div");
    pip.className = "cell-pip";
    cellsGridEl.appendChild(pip);
  }
}

rebuildCellPips();
for (const id of ["up-rail", "up-pods", "up-plate"]) {
  const el = document.getElementById(id)!;
  for (let i = 0; i < 5; i++) {
    const p = document.createElement("div");
    p.className = "up-pip";
    el.appendChild(p);
  }
}

function enqueueRadio(messages: RadioMessage[], interrupt = false) {
  if (interrupt) {
    radioQueue.length = 0;
    activeRadio = null;
    radioTimer = 0;
  }
  for (const m of messages) radioQueue.push(m);
  if (!activeRadio) advanceRadio();
}

function clearRadio() {
  radioQueue.length = 0;
  activeRadio = null;
  radioTimer = 0;
  radioBoxEl.classList.add("hidden");
}

function advanceRadio() {
  const next = radioQueue.shift() ?? null;
  activeRadio = next;
  if (!next) {
    radioBoxEl.classList.add("hidden");
    return;
  }
  radioTimer = next.duration ?? 4.6;
  radioBoxEl.className = `radio-box speaker-${next.speaker}`;
  radioPortraitEl.innerHTML = getSpeakerPortraitSvg(next.speaker);
  radioCallsignEl.textContent = next.callsign;
  radioRoleEl.textContent = next.role;
  radioTextEl.textContent = next.text;
  audio.playRadioBeep(next.speaker);
}

radioBoxEl.addEventListener("click", (e) => {
  e.stopPropagation();
  advanceRadio();
});

function applyAtmosphere(atmo: ChapterDef["atmosphere"]) {
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.setHex(atmo.fogColor);
    scene.fog.density = atmo.fogDensity;
  }
  sun.color.setHex(atmo.sunColor);
  sun.intensity = atmo.sunIntensity;
  hemi.color.setHex(atmo.hemiSky);
  hemi.groundColor.setHex(atmo.hemiGround);
  skyMat.color.setHex(atmo.skyTint);
}

function makeWaypointEl(label: string, color: "amber" | "green" | "red"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `world-wp ${color}`;
  el.innerHTML = `<span class="world-wp-tag">${label}</span><span class="world-wp-dot"></span>`;
  worldWaypointsEl.appendChild(el);
  return el;
}

function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

let calloutTimer = 0;
function showCallout(msg: string) {
  calloutEl.textContent = msg;
  calloutEl.classList.add("show");
  window.clearTimeout(calloutTimer);
  calloutTimer = window.setTimeout(() => calloutEl.classList.remove("show"), 2300);
}

// ── 8. Spawners: Waves, Energy Cores, Support Squad & Missile Pod ────────────
const WAVE_TITLES = ["Outpost ridge", "Dune vanguard", "Red canyon", "Sandstorm legion", "Siege breaker"];

function spawnCore(x: number, z: number) {
  if (energyCores.length >= 6) {
    const old = energyCores.shift()!;
    scene.remove(old.rig.group);
  }
  const rig = buildEnergyCore();
  rig.group.position.set(x, getTerrainHeight(x, z), z);
  scene.add(rig.group);
  energyCores.push({ rig, x, z, bob: Math.random() * Math.PI * 2 });
}

function spawnEnemyUnit(ex: number, ez: number, heavy: boolean, hpOverride?: number): Enemy {
  const [sx, sz] = pushOutOfMesas(ex, ez, heavy ? 2.6 : 2.1);
  const rig = buildEnemyMech(heavy);
  rig.group.position.set(sx, getTerrainHeight(sx, sz), sz);
  scene.add(rig.group);

  const hpEl = document.createElement("div");
  hpEl.className = "enemy-hp";
  const fillEl = document.createElement("div");
  fillEl.className = "fill";
  hpEl.appendChild(fillEl);
  enemyBarsEl.appendChild(hpEl);

  const maxHp = hpOverride ?? (heavy ? 115 : 68);
  const enemy: Enemy = {
    id: nextEnemyId++,
    rig,
    x: sx,
    z: sz,
    yaw: Math.PI,
    hp: maxHp,
    maxHp,
    heavy,
    fireCd: 1.4 + Math.random() * 1.6,
    walkCycle: Math.random() * 6,
    strafeDir: Math.random() > 0.5 ? 1 : -1,
    hitFlash: 0,
    hpEl,
    fillEl,
  };
  enemies.push(enemy);
  return enemy;
}

function spawnBossSolaris(bx: number, bz: number): Enemy {
  const [sx, sz] = pushOutOfMesas(bx, bz, 4.4);
  const rig = buildBossMech();
  rig.group.position.set(sx, getTerrainHeight(sx, sz), sz);
  scene.add(rig.group);

  // Hidden dummy bar (SOLARIS-0 uses the dramatic top-center #boss-bar!)
  const hpEl = document.createElement("div");
  hpEl.className = "enemy-hp";
  hpEl.style.display = "none";
  const fillEl = document.createElement("div");
  hpEl.appendChild(fillEl);

  const maxHp = 1180;
  const boss: Enemy = {
    id: nextEnemyId++,
    rig,
    x: sx,
    z: sz,
    yaw: Math.PI,
    hp: maxHp,
    maxHp,
    heavy: true,
    isBoss: true,
    bossPhase: 1,
    barrageCd: 5.0,
    solarCore: rig.solarCore,
    overdriveAura: rig.overdriveAura,
    fireCd: 1.6,
    walkCycle: 0,
    strafeDir: 1,
    hitFlash: 0,
    hpEl,
    fillEl,
  };
  enemies.push(boss);
  lockedEnemyId = boss.id;
  bossBarEl.classList.remove("hidden", "overdrive");
  bossPhaseEl.textContent = "PHASE I";
  bossFillEl.style.width = "100%";
  audio.playBossSiren();
  return boss;
}

function spawnWave(waveNum: number) {
  const count = Math.min(9, 4 + waveNum);
  for (let i = 0; i < count; i++) {
    const heavy = waveNum >= 2 && i % 3 === 0;
    const spreadAng = ((i / Math.max(1, count - 1)) - 0.5) * 1.35;
    const dist = 46 + Math.random() * 24;
    const ex = Math.sin(spreadAng) * dist;
    const ez = -Math.cos(spreadAng) * dist + 10;
    const maxHp = (heavy ? 115 : 68) + (waveNum - 1) * 16;
    spawnEnemyUnit(ex, ez, heavy, maxHp);
  }
  if (enemies.length > 0) lockedEnemyId = enemies[Math.floor(enemies.length / 2)].id;
  const label = WAVE_TITLES[(waveNum - 1) % WAVE_TITLES.length];
  waveNumEl.textContent = String(waveNum);
  waveTitleEl.textContent = "DUNEFALL";
  waveSubEl.textContent = `${label} · ${enemies.length} on the field`;
  showCallout(`WAVE ${waveNum} // ${label.toUpperCase()}`);
}

function clearStoryEntities() {
  for (const mc of missionCores) {
    scene.remove(mc.rig.group);
    mc.wpEl.remove();
  }
  missionCores.length = 0;
  for (const rt of relayTowers) {
    scene.remove(rt.rig.group);
    rt.wpEl.remove();
  }
  relayTowers.length = 0;
  if (convoy) {
    scene.remove(convoy.rig.group);
    convoy.wpEl.remove();
    convoy = null;
  }
  for (const py of artilleryPylons) {
    scene.remove(py.rig.group);
    py.hpEl.remove();
    py.wpEl.remove();
  }
  artilleryPylons.length = 0;
  for (const dr of dangerRings) scene.remove(dr.rig.group);
  dangerRings.length = 0;
  worldWaypointsEl.innerHTML = "";
  bossBarEl.classList.add("hidden");
  bossBarEl.classList.remove("overdrive");
  chapterTransitionTimer = 0;
  pendingNextChapterIdx = null;
  pendingVictory = false;
}

function spawnMissionCore(x: number, z: number, label: string) {
  const [sx, sz] = pushOutOfMesas(x, z, 2.5);
  const rig = buildMissionCore();
  rig.group.position.set(sx, getTerrainHeight(sx, sz), sz);
  scene.add(rig.group);
  missionCores.push({
    rig,
    x: sx,
    z: sz,
    bob: Math.random() * Math.PI * 2,
    label,
    wpEl: makeWaypointEl(label, "green"),
  });
}

function spawnRelayTower(x: number, z: number, label: string) {
  const [sx, sz] = pushOutOfMesas(x, z, 5.5);
  const radius = 12;
  const rig = buildRelayTower(radius);
  rig.group.position.set(sx, getTerrainHeight(sx, sz), sz);
  scene.add(rig.group);
  relayTowers.push({
    rig,
    x: sx,
    z: sz,
    radius,
    progress: 0,
    captured: false,
    label,
    wpEl: makeWaypointEl(label, "amber"),
  });
}

function spawnConvoyHauler() {
  const startX = 0;
  const startZ = 40;
  const rig = buildConvoyHauler();
  rig.group.position.set(startX, getTerrainHeight(startX, startZ), startZ);
  scene.add(rig.group);
  convoy = {
    rig,
    x: startX,
    z: startZ,
    yaw: 0,
    speed: 0,
    hp: 360,
    maxHp: 360,
    waypointIdx: 0,
    waypoints: [
      [-14, 12],
      [15, -18],
      [0, -56],
    ],
    fireCd: 1.0,
    ambushSpawned: false,
    wpEl: makeWaypointEl("ATLAS-6", "green"),
  };
}

function spawnArtilleryPylon(x: number, z: number, label: string) {
  const [sx, sz] = pushOutOfMesas(x, z, 5.0);
  const rig = buildArtilleryPylon();
  rig.group.position.set(sx, getTerrainHeight(sx, sz), sz);
  scene.add(rig.group);

  const hpEl = document.createElement("div");
  hpEl.className = "enemy-hp";
  const fillEl = document.createElement("div");
  fillEl.className = "fill";
  hpEl.appendChild(fillEl);
  enemyBarsEl.appendChild(hpEl);

  artilleryPylons.push({
    id: nextPylonId++,
    rig,
    x: sx,
    z: sz,
    hp: 260,
    maxHp: 260,
    fireCd: 2.2 + Math.random() * 1.8,
    hitFlash: 0,
    label,
    hpEl,
    fillEl,
    wpEl: makeWaypointEl(label, "red"),
  });
}

function spawnDangerRing(x: number, z: number, radius = 6.5, delay = 1.75, damage = 28) {
  if (dangerRings.length >= 8) return;
  const rig = buildDangerRing(radius);
  rig.group.position.set(x, getTerrainHeight(x, z), z);
  scene.add(rig.group);
  dangerRings.push({ rig, x, z, radius, timer: 0, maxTime: delay, damage });
  audio.playArtilleryWarning();
}

function updateStoryObjectiveHUD(text: string, counter: string, pct: number, sub = "") {
  const ch = CHAPTERS[campaign.chapterIdx];
  objCodeEl.textContent = `${ch.code} · ${ch.title}`;
  objTextEl.textContent = text;
  objCounterEl.textContent = counter;
  objFillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  objSubEl.textContent = sub;
}

function clearDynamicWorld() {
  for (const e of enemies) {
    scene.remove(e.rig.group);
    e.hpEl.remove();
  }
  enemies.length = 0;
  for (const c of allyCars) scene.remove(c.rig.group);
  allyCars.length = 0;
  for (const d of allyDrones) scene.remove(d.mesh);
  allyDrones.length = 0;
  for (const p of missilePods) scene.remove(p.rig.group);
  missilePods.length = 0;
  for (const co of energyCores) scene.remove(co.rig.group);
  energyCores.length = 0;
  for (const pr of projectiles) releaseProjectile(pr);
  projectiles.length = 0;
  for (const pt of particles) releaseParticle(pt);
  particles.length = 0;
  for (const db of debris) releaseDebris(db);
  debris.length = 0;
  clearStoryEntities();
  terrain.clearCraters();
  terrain.spawnCrater(1.5, -12, 3.6);
  terrain.spawnCrater(-9, -24, 2.8);
}

function renderModeMenu() {
  campaignSave = loadCampaignSave();
  storyProgressBadgeEl.textContent = campaignSave.completed
    ? `CLEARED · BEST RANK ${campaignSave.bestRank || "A"}`
    : campaignSave.unlockedChapter > 0
      ? `PROGRESS: CH ${campaignSave.unlockedChapter + 1} / ${CHAPTERS.length}`
      : "5 CHAPTERS · BOSS FINALE";

  chapterPillsEl.innerHTML = "";
  CHAPTERS.forEach((ch, idx) => {
    const cleared = campaignSave.completed || idx < campaignSave.unlockedChapter;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ch-pill${idx === selectedLaunchChapter ? " selected" : ""}`;
    btn.dataset.chapter = String(idx);
    btn.textContent = `${cleared ? "✓ " : ""}CH ${ch.number} · ${ch.title}`;
    btn.addEventListener("click", () => {
      selectedLaunchChapter = idx;
      renderModeMenu();
    });
    chapterPillsEl.appendChild(btn);
  });

  const sel = CHAPTERS[selectedLaunchChapter];
  btnLaunchStory.textContent =
    selectedLaunchChapter === 0 && campaignSave.unlockedChapter === 0
      ? "Start Story Campaign"
      : `Deploy Ch. ${sel.number}: ${sel.title}`;
}

function openModeMenu() {
  menuOpen = true;
  player.paused = true;
  firing = false;
  bracing = false;
  if (document.pointerLockElement) document.exitPointerLock();
  settingsModal.classList.add("hidden");
  gameOverModal.classList.add("hidden");
  briefingModal.classList.add("hidden");
  victoryModal.classList.add("hidden");
  renderModeMenu();
  modeModal.classList.remove("hidden");
}

function startStoryChapter(chapterIdx: number, resetCampaignStats = false) {
  audio.unlock();
  gameMode = "story";
  menuOpen = false;
  modeModal.classList.add("hidden");
  briefingModal.classList.add("hidden");
  victoryModal.classList.add("hidden");
  gameOverModal.classList.add("hidden");
  settingsModal.classList.add("hidden");
  player.paused = false;
  player.studioMode = false;
  studioControls.enabled = false;

  if (resetCampaignStats) {
    campaign = createFreshCampaignState(chapterIdx);
    player.score = 0;
    player.kills = 0;
    player.shots = 0;
    player.tier = Math.min(3, 1 + Math.floor(chapterIdx / 2));
    player.cores = 0;
    player.coresNeeded = 4 + player.tier;
    player.upRail = player.tier;
    player.upPods = player.tier;
    player.upPlate = player.tier;
  } else {
    campaign.chapterIdx = chapterIdx;
    campaign.chapterTime = 0;
  }

  const ch = CHAPTERS[campaign.chapterIdx];
  clearDynamicWorld();
  clearRadio();
  applyAtmosphere(ch.atmosphere);

  const maxHull = 140 + (player.tier - 1) * 20 + campaign.bonusHull;
  const maxPlate = 100 + (player.tier - 1) * 15 + campaign.bonusPlate;
  const maxCells = 6 + campaign.bonusCells;

  Object.assign(player, {
    x: 0,
    z: ch.objectiveType === "escort_convoy" ? 48 : 16,
    vx: 0,
    vz: 0,
    yaw: 0,
    camYaw: 0,
    camPitch: 0.42,
    camZoom: 16.5,
    morph: 0,
    targetMorph: 0,
    siege: 0,
    stance: "strider",
    hull: maxHull,
    maxHull,
    plate: maxPlate,
    maxPlate,
    heat: 0,
    overheated: false,
    cells: maxCells,
    maxCells,
    fireCd: 0,
    missileCd: 0,
    squadCd: 0,
    podCd: 0,
    dashTimer: 0,
    wave: ch.number,
    trauma: 0,
    hitStop: 0,
  });
  rebuildCellPips();

  storyPhase = 0;
  storyKillsNeeded = 0;
  storyKillsCount = 0;
  storyCoresCollected = 0;
  storyCoresTotal = 0;
  storyReinforceTimer = 10;

  // Story HUD mode
  objectiveBarEl.classList.remove("hidden");
  waveNumEl.textContent = `C${ch.number}`;
  waveTitleEl.textContent = ch.title;
  waveSubEl.textContent = `${ch.sector} · ${ch.code}`;

  // Allied wingman car beside player in Chapters 1–4
  if (ch.objectiveType !== "boss_solaris") {
    spawnAllyCarAt(player.x + 7.5, player.z - 2, 999);
  }
  spawnCore(-11.5, player.z - 3);

  // Chapter-specific 3D mission setup
  if (ch.objectiveType === "recon_and_cores") {
    storyKillsNeeded = 5;
    for (let i = 0; i < 5; i++) {
      const ang = ((i / 4) - 0.5) * 1.25;
      const dist = 42 + (i % 2) * 14;
      spawnEnemyUnit(Math.sin(ang) * dist, -Math.cos(ang) * dist + 14, i === 2, i === 2 ? 96 : 62);
    }
    updateStoryObjectiveHUD("Eliminate Crimson Recon Vanguard", "0 / 5", 0, "Press [Q] to lock targets · [LMB] to fire");
  } else if (ch.objectiveType === "capture_relays") {
    spawnRelayTower(-30, -24, "RELAY A");
    spawnRelayTower(32, -38, "RELAY B");
    spawnEnemyUnit(-24, -36, false, 74);
    spawnEnemyUnit(-36, -16, false, 74);
    spawnEnemyUnit(28, -48, true, 125);
    spawnEnemyUnit(36, -26, false, 74);
    updateStoryObjectiveHUD("Capture Helios Relay Towers", "0 / 2", 0, "Stand inside glowing perimeter rings to upload");
  } else if (ch.objectiveType === "escort_convoy") {
    spawnConvoyHauler();
    spawnEnemyUnit(-20, 4, false, 74);
    spawnEnemyUnit(22, -2, false, 74);
    spawnEnemyUnit(-6, -18, true, 125);
    updateStoryObjectiveHUD("Escort ATLAS-6 to Extraction Gate", "0%", 0, "Stay within 24m of ATLAS-6 for Escort Boost");
  } else if (ch.objectiveType === "destroy_pylons") {
    spawnArtilleryPylon(-32, -26, "PYLON 1");
    spawnArtilleryPylon(34, -22, "PYLON 2");
    spawnArtilleryPylon(0, -58, "PYLON 3");
    spawnEnemyUnit(-22, -34, false, 78);
    spawnEnemyUnit(26, -32, false, 78);
    spawnEnemyUnit(-8, -48, true, 132);
    spawnEnemyUnit(12, -46, false, 78);
    updateStoryObjectiveHUD("Destroy Crimson Artillery Pylons", "0 / 3", 0, "Dodge red ground impact rings · [K]/[L] deal heavy damage");
  } else if (ch.objectiveType === "boss_solaris") {
    spawnBossSolaris(0, -46);
    spawnEnemyUnit(-20, -38, false, 76);
    spawnEnemyUnit(20, -38, false, 76);
    spawnCore(14, 10);
    updateStoryObjectiveHUD("Defeat Warden Vex in SOLARIS-0", "100% HP", 0, "Break SOLARIS-0 below 50% HP to expose Solar Overdrive");
  }

  if (enemies.length > 0 && !lockedEnemyId) lockedEnemyId = enemies[0].id;
  updateWeaponSlotsUI();
  updateStanceButtonsUI();
  showCallout(`${ch.code} // ${ch.title}`);
  enqueueRadio(ch.introComms, true);
}

function startEndlessMode() {
  audio.unlock();
  gameMode = "endless";
  menuOpen = false;
  modeModal.classList.add("hidden");
  briefingModal.classList.add("hidden");
  victoryModal.classList.add("hidden");
  gameOverModal.classList.add("hidden");
  settingsModal.classList.add("hidden");
  player.paused = false;
  objectiveBarEl.classList.add("hidden");
  bossBarEl.classList.add("hidden");
  clearRadio();
  applyAtmosphere(CHAPTERS[0].atmosphere);
  resetBattlefield();
}

function openChapterBriefing(clearedIdx: number, nextIdx: number) {
  const cleared = CHAPTERS[clearedIdx];
  const next = CHAPTERS[nextIdx];
  player.paused = true;
  firing = false;
  bracing = false;
  if (document.pointerLockElement) document.exitPointerLock();

  briefKickerEl.textContent = `${cleared.code} COMPLETE // ${cleared.title}`;
  briefSectorEl.textContent = next.sector.toUpperCase();
  briefSummaryEl.textContent = `+500 OP BONUS · TOTAL SCORE ${player.score.toLocaleString()} · TIME ${formatTime(campaign.chapterTime)}`;

  nextOpCodeEl.textContent = `NEXT OP // ${next.code}`;
  nextOpTitleEl.textContent = next.title;
  nextOpBriefEl.textContent = next.briefing;
  nextOpHintEl.textContent = `TACTICAL TIP: ${next.hint}`;

  pendingBriefingChoice = null;
  choiceGridEl.innerHTML = "";
  if (cleared.debriefChoices) {
    choiceSectionEl.classList.remove("hidden");
    cleared.debriefChoices.forEach((choice, idx) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `choice-card${idx === 0 ? " picked" : ""}`;
      if (idx === 0) pendingBriefingChoice = choice.id;
      card.innerHTML = `<span class="choice-tag">${choice.tag}</span><div class="choice-title">${choice.title}</div><div class="choice-effect">${choice.effectText}</div>`;
      card.addEventListener("click", () => {
        pendingBriefingChoice = choice.id;
        choiceGridEl.querySelectorAll(".choice-card").forEach((c) => c.classList.remove("picked"));
        card.classList.add("picked");
        audio.playDeploy();
      });
      choiceGridEl.appendChild(card);
    });
  } else {
    choiceSectionEl.classList.add("hidden");
  }

  btnDeployNext.textContent = `Deploy ${next.code}: ${next.title}`;
  briefingModal.classList.remove("hidden");
}

function submitStartNgStats(targetRankEl: HTMLElement) {
  const runStats = {
    score: Math.max(0, Math.round(player.score)),
    waves: Math.max(1, Math.round(gameMode === "story" ? CHAPTERS[campaign.chapterIdx].number : player.wave)),
    kills: Math.max(0, Math.round(player.kills)),
  };
  targetRankEl.textContent = "Saving run to start.ng leaderboard...";
  const kit = (window as unknown as { startng?: StartNgKit }).startng;
  if (kit?.saveRun) {
    kit
      .saveRun(runStats)
      .then((res) => {
        if (res?.ok && res.result) {
          targetRankEl.textContent = `Leaderboard Rank #${res.result.rank ?? "-"} · Best ${res.result.best ?? runStats.score}`;
        } else {
          targetRankEl.textContent = "Sign in on start.ng to save your best run to the leaderboard.";
        }
      })
      .catch(() => {
        targetRankEl.textContent = "Sign in on start.ng to save your best run to the leaderboard.";
      });
  } else {
    targetRankEl.textContent = "Play on start.ng to save your best run to the global leaderboard.";
  }
}

function showVictoryScreen() {
  player.paused = true;
  firing = false;
  bracing = false;
  if (document.pointerLockElement) document.exitPointerLock();

  const rank = computeCampaignRank(player.score, campaign.deaths, campaign.totalTime);
  campaignSave.completed = true;
  campaignSave.unlockedChapter = CHAPTERS.length - 1;
  if (player.score > campaignSave.bestScore) {
    campaignSave.bestScore = Math.round(player.score);
    campaignSave.bestRank = rank;
  }
  persistCampaignSave(campaignSave);

  vicRankLetterEl.textContent = rank;
  vicScoreEl.textContent = player.score.toLocaleString();
  vicTimeEl.textContent = formatTime(campaign.totalTime);
  vicKillsEl.textContent = String(player.kills);
  victoryModal.classList.remove("hidden");
  submitStartNgStats(vicRankEl);
}

function completeStoryChapter() {
  if (storyPhase >= 2) return;
  storyPhase = 2;
  const ch = CHAPTERS[campaign.chapterIdx];
  player.score += ch.index === 4 ? 1500 : 500;
  audio.playObjectiveComplete();
  showCallout(`${ch.code} CLEARED // ${ch.title}`);
  enqueueRadio(ch.clearComms, true);

  if (campaign.chapterIdx + 1 < CHAPTERS.length) {
    const nextIdx = campaign.chapterIdx + 1;
    if (nextIdx > campaignSave.unlockedChapter) {
      campaignSave.unlockedChapter = nextIdx;
      persistCampaignSave(campaignSave);
    }
    pendingNextChapterIdx = nextIdx;
    chapterTransitionTimer = 2.4;
  } else {
    pendingVictory = true;
    chapterTransitionTimer = 2.8;
  }
}

function failStoryChapter(reasonTitle: string) {
  if (player.paused) return;
  campaign.deaths += 1;
  player.paused = true;
  firing = false;
  bracing = false;
  if (document.pointerLockElement) document.exitPointerLock();

  const ch = CHAPTERS[campaign.chapterIdx];
  goTitleEl.textContent = reasonTitle;
  goWaveLblEl.textContent = "CHAPTER";
  goScoreEl.textContent = Math.round(player.score).toLocaleString();
  goWaveEl.textContent = `${ch.number} / 5`;
  goKillsEl.textContent = String(player.kills);
  btnPlayAgain.textContent = `Retry Ch. ${ch.number}: ${ch.title}`;
  gameOverModal.classList.remove("hidden");
  submitStartNgStats(goRankEl);
}

function spawnAllyCarAt(x: number, z: number, life = 38) {
  const rig = buildAllyCar();
  rig.group.position.set(x, getTerrainHeight(x, z), z);
  scene.add(rig.group);
  allyCars.push({
    rig,
    x,
    z,
    yaw: 0,
    speed: 0,
    fireCd: 0.6 + Math.random() * 0.5,
    orbitAngle: Math.random() * Math.PI * 2,
    life,
  });
}

function deploySupportSquad() {
  if (player.squadCd > 0) return;
  audio.unlock();
  audio.playDeploy();
  const cdMult = gameMode === "story" ? campaign.cooldownMult : 1;
  player.squadCd = Math.max(12, (30 - player.upPods * 2.5) * cdMult);

  // Deploy 3 allied 6-wheel cars + 2 hover combat drones!
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2 + player.yaw;
    const cx = player.x + Math.cos(ang) * 9;
    const cz = player.z + Math.sin(ang) * 9;
    spawnAllyCarAt(cx, cz, 34);
    spawnSparkBurst(cx, getTerrainHeight(cx, cz) + 0.8, cz, 8, 0x4ade80, 9);
  }
  for (let i = 0; i < 2; i++) {
    const mesh = buildAllyDrone();
    const dx = player.x + (i === 0 ? -5.5 : 5.5);
    const dz = player.z - 2;
    const dy = getTerrainHeight(dx, dz) + 6.5;
    mesh.position.set(dx, dy, dz);
    scene.add(mesh);
    allyDrones.push({ mesh, x: dx, y: dy, z: dz, orbitAngle: i * Math.PI, fireCd: 0.4, life: 30 });
  }
  showCallout("SUPPORT SQUAD DEPLOYED · 2 DRONES + 3 CARS");
}

function deployMissilePod() {
  if (player.podCd > 0) return;
  audio.unlock();
  audio.playDeploy();
  const cdMult = gameMode === "story" ? campaign.cooldownMult : 1;
  player.podCd = Math.max(10, (26 - player.upPods * 2) * cdMult);

  const px = player.x + Math.cos(player.yaw) * 4.5;
  const pz = player.z - Math.sin(player.yaw) * 4.5;
  const rig = buildMissilePod();
  rig.group.position.set(px, getTerrainHeight(px, pz), pz);
  scene.add(rig.group);
  missilePods.push({ rig, x: px, z: pz, fireCd: 0.6, life: 20 });
  spawnSparkBurst(px, getTerrainHeight(px, pz) + 0.6, pz, 12, 0xffb94a, 10);
  showCallout("MISSILE POD ONLINE · 20S DEPLOYMENT");
}

function resetBattlefield() {
  if (gameMode === "story" && !menuOpen) {
    startStoryChapter(campaign.chapterIdx, false);
    return;
  }
  clearDynamicWorld();
  clearRadio();

  Object.assign(player, {
    x: 0,
    z: 12,
    vx: 0,
    vz: 0,
    yaw: 0,
    camYaw: 0,
    camPitch: 0.42,
    camZoom: 16.5,
    morph: 0,
    targetMorph: 0,
    siege: 0,
    stance: "strider",
    weaponSlot: 0,
    hull: 140,
    maxHull: 140,
    plate: 100,
    maxPlate: 100,
    heat: 0,
    overheated: false,
    cells: 6,
    maxCells: 6,
    fireCd: 0,
    missileCd: 0,
    squadCd: 0,
    podCd: 0,
    dashTimer: 0,
    shots: 0,
    kills: 0,
    score: 0,
    cores: 0,
    coresNeeded: 4,
    tier: 1,
    wave: 1,
    upRail: 1,
    upPods: 1,
    upPlate: 1,
    trauma: 0,
    hitStop: 0,
  });
  rebuildCellPips();

  // Iconic opening scene: 1 wingman 6-wheel green-core car right beside you + 1 green Core on the left flank!
  spawnAllyCarAt(7.2, 10.4, 999);
  spawnCore(-11.5, 11.2);
  spawnWave(1);
  updateWeaponSlotsUI();
  updateStanceButtonsUI();
}

// ── 9. Input Handling & Actions ──────────────────────────────────────────────
const keys = new Set<string>();
let firing = false;
let bracing = false;
let pointerLocked = false;

function selectWeapon(slot: number) {
  player.weaponSlot = Math.max(0, Math.min(WEAPONS.length - 1, slot));
  updateWeaponSlotsUI();
  showCallout(`WEAPON // ${WEAPONS[player.weaponSlot].name}`);
}

function updateWeaponSlotsUI() {
  document.querySelectorAll<HTMLButtonElement>(".loadout-slot").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.slot) === player.weaponSlot);
  });
}

function updateStanceButtonsUI() {
  btnDrive.classList.toggle("active", player.stance === "car");
  btnStance.classList.toggle("active", player.stance === "siege");
  btnStance.innerHTML = player.stance === "siege" ? "Siege · <kbd>X</kbd>" : "Strider · <kbd>Z</kbd>";
  btnStudio.classList.toggle("active", player.studioMode);
}

function setStance(next: "strider" | "siege" | "car") {
  audio.unlock();
  if (next === "car" && player.stance === "car") next = "strider";
  const wasCar = player.stance === "car";
  player.stance = next;
  player.targetMorph = next === "car" ? 1 : 0;
  if ((next === "car") !== wasCar) {
    audio.playTransform(next === "car");
    spawnSparkBurst(player.x, getTerrainHeight(player.x, player.z) + 1.4, player.z, 12, next === "car" ? 0x4ade80 : 0xffc864, 10);
    showCallout(next === "car" ? "TRANSFORM // 6x6 COMBAT CAR" : "TRANSFORM // HEAVY WAR MECH");
  } else {
    showCallout(next === "siege" ? "STANCE // SIEGE MODE (+45% FIREPOWER)" : "STANCE // STRIDER MODE");
  }
  updateStanceButtonsUI();
}

function cycleTarget() {
  if (enemies.length === 0) return;
  const idx = enemies.findIndex((e) => e.id === lockedEnemyId);
  const next = enemies[(idx + 1) % enemies.length];
  lockedEnemyId = next.id;
  audio.playHit(false);
}

function fireHomingSalvo() {
  if (player.missileCd > 0 || player.cells < 2) {
    if (player.cells < 2) showCallout("LOW CELLS · RECHARGING");
    return;
  }
  audio.unlock();
  audio.playMissile();
  player.cells -= 2;
  player.missileCd = 1.6;
  player.trauma = Math.min(1, player.trauma + 0.22);

  const target = getLockedEnemy() ?? enemies[0] ?? null;
  const salvoCount = 2 + Math.min(3, player.upPods);
  const baseY = getTerrainHeight(player.x, player.z) + (player.morph > 0.5 ? 1.8 : 4.2);

  for (let i = 0; i < salvoCount; i++) {
    const spread = (i - (salvoCount - 1) / 2) * 0.42;
    const launchYaw = player.camYaw + spread;
    spawnProjectile({
      x: player.x - Math.sin(launchYaw) * 1.2,
      y: baseY,
      z: player.z - Math.cos(launchYaw) * 1.2,
      dirX: -Math.sin(launchYaw) * 0.72,
      dirY: 0.68,
      dirZ: -Math.cos(launchYaw) * 0.72,
      speed: 44,
      damage: 42 + player.upPods * 8,
      color: 0xffb347,
      friendly: true,
      splash: 5.5,
      isMissile: true,
      homingTarget: target,
    });
  }
  showCallout(`MISSILE SALVO · ${salvoCount} ROCKETS AWAY`);
}

function triggerSideRoll(dirSign: -1 | 1) {
  if (player.dashTimer > 0 || player.cells < 1) return;
  audio.unlock();
  audio.playDash();
  player.cells -= 1;
  player.dashTimer = 0.28;
  // Right vector relative to camYaw (forward = (-sin, -cos), right = (cos, -sin))
  player.dashDirX = Math.cos(player.camYaw) * dirSign;
  player.dashDirZ = -Math.sin(player.camYaw) * dirSign;
  player.trauma = Math.min(1, player.trauma + 0.16);
  spawnSparkBurst(player.x, getTerrainHeight(player.x, player.z) + 1.0, player.z, 14, 0xff9a3c, 13);
}

function toggleSettings(force?: boolean) {
  if (menuOpen || !briefingModal.classList.contains("hidden") || !victoryModal.classList.contains("hidden") || !gameOverModal.classList.contains("hidden")) {
    return;
  }
  const open = force ?? settingsModal.classList.contains("hidden");
  settingsModal.classList.toggle("hidden", !open);
  player.paused = open;
  if (open && document.pointerLockElement) document.exitPointerLock();
}

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "escape") {
    toggleSettings();
    return;
  }
  if (player.paused) return;
  keys.add(k);
  audio.unlock();

  if (!e.repeat) {
    if (k === "g") selectWeapon(0);
    else if (k === "h") selectWeapon(1);
    else if (k === "j") selectWeapon(2);
    else if (k === "k") selectWeapon(3);
    else if (k === "l") selectWeapon(4);
    else if (k === "t") setStance(player.stance === "car" ? "strider" : "car");
    else if (k === "x") setStance("siege");
    else if (k === "z") setStance("strider");
    else if (k === "q") cycleTarget();
    else if (k === "f") fireHomingSalvo();
    else if (k === "4") deploySupportSquad();
    else if (k === "5") deployMissilePod();
    else if (k === "p") {
      player.freezeEnemies = !player.freezeEnemies;
      syncSettingsUI();
      showCallout(player.freezeEnemies ? "ENEMIES FROZEN" : "ENEMIES RESUMED");
    } else if (k === "i") {
      player.studioMode = !player.studioMode;
      studioControls.enabled = player.studioMode;
      if (player.studioMode) {
        if (document.pointerLockElement) document.exitPointerLock();
        studioControls.target.set(player.x, getTerrainHeight(player.x, player.z) + 2.2, player.z);
        showCallout("STUDIO ORBIT CAMERA · DRAG TO INSPECT");
      }
      updateStanceButtonsUI();
    } else if (e.shiftKey && (k === "a" || k === "arrowleft")) {
      triggerSideRoll(-1);
    } else if (e.shiftKey && (k === "d" || k === "arrowright")) {
      triggerSideRoll(1);
    }
  }
});

window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

canvas.addEventListener("mousedown", (e) => {
  if (player.paused) return;
  audio.unlock();
  if (e.button === 0) {
    firing = true;
    if (!player.studioMode && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  } else if (e.button === 2) {
    bracing = true;
  }
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) bracing = false;
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  aimHintEl.classList.toggle("hidden", pointerLocked);
});

window.addEventListener("mousemove", (e) => {
  if (player.paused || player.studioMode) return;
  if (pointerLocked) {
    player.camYaw -= e.movementX * 0.0024;
    player.camPitch = THREE.MathUtils.clamp(player.camPitch + e.movementY * 0.002, -0.05, 0.72);
  }
});

window.addEventListener(
  "wheel",
  (e) => {
    if (player.studioMode) return;
    player.camZoom = THREE.MathUtils.clamp(player.camZoom + e.deltaY * 0.012, 8.5, 28);
  },
  { passive: true }
);

// Wire HUD buttons
document.querySelectorAll<HTMLButtonElement>(".loadout-slot").forEach((b) => {
  b.addEventListener("click", () => selectWeapon(Number(b.dataset.slot)));
});
btnSquad.addEventListener("click", deploySupportSquad);
btnPod.addEventListener("click", deployMissilePod);
btnDrive.addEventListener("click", () => setStance(player.stance === "car" ? "strider" : "car"));
btnStance.addEventListener("click", () => setStance(player.stance === "siege" ? "strider" : "siege"));
btnStudio.addEventListener("click", () => {
  player.studioMode = !player.studioMode;
  studioControls.enabled = player.studioMode;
  if (player.studioMode) {
    studioControls.target.set(player.x, getTerrainHeight(player.x, player.z) + 2.2, player.z);
  }
  updateStanceButtonsUI();
});
document.getElementById("btn-modes")!.addEventListener("click", openModeMenu);
document.getElementById("btn-modal-modes")!.addEventListener("click", openModeMenu);
document.getElementById("btn-go-modes")!.addEventListener("click", openModeMenu);
btnLaunchStory.addEventListener("click", () => startStoryChapter(selectedLaunchChapter, true));
btnLaunchEndless.addEventListener("click", startEndlessMode);
btnDeployNext.addEventListener("click", () => {
  const cleared = CHAPTERS[campaign.chapterIdx];
  const nextIdx = pendingNextChapterIdx ?? Math.min(CHAPTERS.length - 1, campaign.chapterIdx + 1);
  let choiceResp: RadioMessage | null = null;
  if (pendingBriefingChoice && cleared.debriefChoices) {
    applyTacticalChoice(campaign, pendingBriefingChoice);
    const chosen = cleared.debriefChoices.find((c) => c.id === pendingBriefingChoice);
    if (chosen) choiceResp = chosen.response;
  }
  pendingNextChapterIdx = null;
  pendingBriefingChoice = null;
  startStoryChapter(nextIdx, false);
  if (choiceResp) enqueueRadio([choiceResp], false);
});
document.getElementById("btn-vic-endless")!.addEventListener("click", startEndlessMode);
document.getElementById("btn-vic-replay")!.addEventListener("click", () => startStoryChapter(0, true));
document.getElementById("btn-vic-share")!.addEventListener("click", shareOnX);

document.getElementById("btn-restart")!.addEventListener("click", resetBattlefield);
document.getElementById("btn-modal-restart")!.addEventListener("click", () => {
  resetBattlefield();
  toggleSettings(false);
});
document.getElementById("btn-pause")!.addEventListener("click", () => toggleSettings(true));
document.getElementById("btn-close-settings")!.addEventListener("click", () => toggleSettings(false));
document.getElementById("btn-resume")!.addEventListener("click", () => toggleSettings(false));
document.getElementById("btn-fs")!.addEventListener("click", () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});

// ── start.ng Integration: Pilot Profile, Score Sharing on X, Leaderboard Save & Touch ──
type StartNgPlayer = {
  id?: number;
  name?: string;
  account?: string;
  face?: string;
};
type StartNgReply = {
  user?: StartNgPlayer | null;
  guest?: StartNgPlayer | null;
};
type StartNgKit = {
  getPlayer?: () => Promise<StartNgReply | null>;
  onPlayerChange?: (fn: (reply: StartNgReply | null) => void) => void;
  signIn?: () => void;
  saveRun?: (stats: Record<string, number>) => Promise<{ ok?: boolean; result?: { best?: number; improved?: boolean; rank?: number } } | null>;
  share?: (opts: { score?: number }) => void;
};

const touchMove = { up: false, down: false, left: false, right: false };

function shareOnX() {
  const gameUrl = location.hostname.endsWith(".start.ng")
    ? `https://start.ng/games/${location.hostname.replace(/\.start\.ng$/, "")}`
    : location.href;
  const text =
    gameMode === "story" && !victoryModal.classList.contains("hidden")
      ? `I defeated Warden Vex (SOLARIS-0) with Rank ${vicRankLetterEl.textContent} and ${player.score.toLocaleString()} pts in DUNEFALL Story Campaign on start.ng!`
      : gameMode === "story"
        ? `Fighting through Chapter ${CHAPTERS[campaign.chapterIdx].number} (${CHAPTERS[campaign.chapterIdx].title}) with ${player.score.toLocaleString()} pts in DUNEFALL on start.ng!`
        : `I reached Wave ${player.wave} with ${player.score.toLocaleString()} pts (${player.kills} mechs destroyed) in DUNEFALL on start.ng! Can you beat my score?`;
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(gameUrl)}`;
  window.open(url, "_blank", "noopener");
}

document.getElementById("btn-share")!.addEventListener("click", shareOnX);
document.getElementById("btn-go-share")!.addEventListener("click", shareOnX);

const gameOverModal = document.getElementById("gameover-modal")!;
const goScoreEl = document.getElementById("go-score")!;
const goWaveEl = document.getElementById("go-wave")!;
const goKillsEl = document.getElementById("go-kills")!;
const goRankEl = document.getElementById("go-rank")!;

document.getElementById("btn-play-again")!.addEventListener("click", () => {
  gameOverModal.classList.add("hidden");
  player.paused = false;
  resetBattlefield();
});

const pilotFaceEl = document.getElementById("pilot-face") as HTMLImageElement;
const pilotNameEl = document.getElementById("pilot-name")!;
const pilotAccountEl = document.getElementById("pilot-account")!;
const pilotSigninBtn = document.getElementById("pilot-signin")!;

function renderPilotCard(reply: StartNgReply | null) {
  const active = reply?.user ?? reply?.guest;
  if (!active) return;
  if (active.face) {
    pilotFaceEl.src = active.face;
    pilotFaceEl.hidden = false;
  }
  pilotNameEl.textContent = active.name || "Guest Pilot";
  pilotAccountEl.textContent = reply?.user?.account ? `@${reply.user.account} · start.ng` : "Guest · start.ng";
  const skipSignIn = new URLSearchParams(location.search).has("guest");
  pilotSigninBtn.hidden = !!reply?.user || skipSignIn;
}

pilotSigninBtn.addEventListener("click", () => {
  const kit = (window as unknown as { startng?: StartNgKit }).startng;
  if (kit?.signIn) {
    kit.signIn();
  } else {
    location.href = `https://start.ng/?return_to=${encodeURIComponent(location.origin + location.pathname)}`;
  }
});

function initStartNg() {
  const sng = (window as unknown as { startng?: StartNgKit }).startng;
  if (sng && sng.getPlayer) {
    sng.getPlayer().then(renderPilotCard).catch(() => {});
    sng.onPlayerChange?.(renderPilotCard);
    return;
  }
  // Fallback direct connect check (startng:whoami) if kit.js hasn't attached yet
  if (location.hostname.endsWith(".start.ng")) {
    const iframe = document.createElement("iframe");
    iframe.src = "https://start.ng/connect";
    iframe.hidden = true;
    iframe.onload = () => {
      const requestId = Math.random().toString(36).slice(2);
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== "https://start.ng" || e.source !== iframe.contentWindow) return;
        if (e.data?.type === "startng:user" && e.data.requestId === requestId) {
          window.removeEventListener("message", onMsg);
          renderPilotCard(e.data as StartNgReply);
        }
      };
      window.addEventListener("message", onMsg);
      iframe.contentWindow?.postMessage({ type: "startng:whoami", requestId }, "https://start.ng");
    };
    document.body.appendChild(iframe);
  }
}
window.addEventListener("load", initStartNg);
initStartNg();

// Mobile touch controls (D-pad + Fire/Car/Missile/Squad + swipe-to-aim)
document.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((btn) => {
  const act = btn.dataset.m!;
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    audio.unlock();
    if (act === "up" || act === "down" || act === "left" || act === "right") touchMove[act] = true;
    else if (act === "fire") firing = true;
    else if (act === "car") setStance(player.stance === "car" ? "strider" : "car");
    else if (act === "missile") fireHomingSalvo();
    else if (act === "squad") deploySupportSquad();
  });
  const release = () => {
    if (act === "up" || act === "down" || act === "left" || act === "right") touchMove[act] = false;
    else if (act === "fire") firing = false;
  };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
});

let touchAimId: number | null = null;
let touchLastX = 0;
let touchLastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || player.paused || player.studioMode) return;
  touchAimId = e.pointerId;
  touchLastX = e.clientX;
  touchLastY = e.clientY;
});
window.addEventListener("pointermove", (e) => {
  if (touchAimId !== e.pointerId || player.paused || player.studioMode) return;
  const dx = e.clientX - touchLastX;
  const dy = e.clientY - touchLastY;
  touchLastX = e.clientX;
  touchLastY = e.clientY;
  player.camYaw -= dx * 0.0055;
  player.camPitch = THREE.MathUtils.clamp(player.camPitch + dy * 0.004, -0.05, 0.72);
});
window.addEventListener("pointerup", (e) => {
  if (touchAimId === e.pointerId) touchAimId = null;
});

const btnGfx = document.getElementById("btn-gfx")!;
const toggleQualityBtn = document.getElementById("toggle-quality")!;
const toggleAudioBtn = document.getElementById("toggle-audio")!;
const toggleFreezeBtn = document.getElementById("toggle-freeze")!;
const toggleShakeBtn = document.getElementById("toggle-shake")!;

function syncSettingsUI() {
  toggleQualityBtn.textContent = ecoMode ? "Eco (Fast GPU)" : "High PBR + Bloom";
  toggleQualityBtn.classList.toggle("active", !ecoMode);
  btnGfx.textContent = ecoMode ? "Eco GPU" : "Bloom PBR";
  btnGfx.classList.toggle("active", !ecoMode);
  toggleAudioBtn.textContent = audio.enabled ? "Sound On" : "Muted";
  toggleAudioBtn.classList.toggle("active", audio.enabled);
  toggleFreezeBtn.textContent = player.freezeEnemies ? "Frozen" : "Active AI";
  toggleFreezeBtn.classList.toggle("active", player.freezeEnemies);
  toggleShakeBtn.textContent = `${Math.round(player.shakeMult * 100)}%`;
  toggleShakeBtn.classList.toggle("active", player.shakeMult > 0);
}

function flipGraphicsPreset() {
  ecoMode = !ecoMode;
  const pr = ecoMode ? 1.0 : Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(pr);
  if (!ecoMode) ensureComposer();
  composer?.setPixelRatio(pr);
  sun.shadow.mapSize.set(ecoMode ? 1024 : 2048, ecoMode ? 1024 : 2048);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
  syncSettingsUI();
  showCallout(ecoMode ? "ECO GPU · DIRECT RENDER + 1024 SHADOWS" : "HIGH PBR · BLOOM + 2048 SHADOWS");
}

toggleQualityBtn.addEventListener("click", flipGraphicsPreset);
btnGfx.addEventListener("click", flipGraphicsPreset);
toggleAudioBtn.addEventListener("click", () => {
  audio.setEnabled(!audio.enabled);
  syncSettingsUI();
});
toggleFreezeBtn.addEventListener("click", () => {
  player.freezeEnemies = !player.freezeEnemies;
  syncSettingsUI();
});
toggleShakeBtn.addEventListener("click", () => {
  player.shakeMult = player.shakeMult === 1 ? 0.35 : player.shakeMult > 0 ? 0 : 1;
  syncSettingsUI();
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (bloomPass) bloomPass.setSize(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
});

// ── 10. Helpers: Target Lock, Damage & Solid Collision Push-Out ──────────────
function getLockedEnemy(): Enemy | null {
  if (lockedEnemyId === null) return null;
  return enemies.find((e) => e.id === lockedEnemyId) ?? null;
}

function pushOutOfMesas(x: number, z: number, radius: number): [number, number] {
  for (const m of terrain.mesas) {
    const dx = x - m.x;
    const dz = z - m.z;
    const minDist = m.radius + radius;
    const dSq = dx * dx + dz * dz;
    if (dSq < minDist * minDist && dSq > 1e-6) {
      const d = Math.sqrt(dSq);
      x = m.x + (dx / d) * minDist;
      z = m.z + (dz / d) * minDist;
    }
  }
  const dist = Math.hypot(x, z);
  if (dist > terrain.arenaRadius) {
    x = (x / dist) * terrain.arenaRadius;
    z = (z / dist) * terrain.arenaRadius;
  }
  return [x, z];
}

function damagePylon(py: ArtilleryPylon, amount: number) {
  const pierce = gameMode === "story" ? campaign.armorPierceMult : 1;
  py.hp -= amount * pierce;
  py.hitFlash = 0.12;
  if (py.hp <= 0) {
    const gy = getTerrainHeight(py.x, py.z);
    spawnExplosion(py.x, gy + 1.5, py.z, true);
    audio.playHit(true);
    player.kills += 1;
    player.score += 320;
    spawnCore(py.x, py.z);

    scene.remove(py.rig.group);
    py.hpEl.remove();
    py.wpEl.remove();
    const idx = artilleryPylons.indexOf(py);
    if (idx !== -1) artilleryPylons.splice(idx, 1);

    const destroyed = 3 - artilleryPylons.length;
    updateStoryObjectiveHUD(
      "Destroy Crimson Artillery Pylons",
      `${destroyed} / 3`,
      (destroyed / 3) * 100,
      artilleryPylons.length > 0 ? `${artilleryPylons.length} siege pylon(s) still firing` : "All siege pylons neutralized!"
    );

    if (artilleryPylons.length === 1 && storyPhase === 0) {
      storyPhase = 1;
      enqueueRadio(CHAPTERS[3].twistComms, true);
      spawnEnemyUnit(artilleryPylons[0].x - 10, artilleryPylons[0].z + 10, true, 136);
      spawnEnemyUnit(artilleryPylons[0].x + 10, artilleryPylons[0].z + 10, true, 136);
      showCallout("CRIMSON HEAVY BREACHERS INBOUND");
    } else if (artilleryPylons.length === 0) {
      completeStoryChapter();
    }
  } else {
    audio.playHit(false);
  }
}

function damageEnemy(e: Enemy, amount: number) {
  const pierce = gameMode === "story" && (e.heavy || e.isBoss) ? campaign.armorPierceMult : 1;
  e.hp -= amount * pierce;
  e.hitFlash = 0.12;

  // Boss SOLARIS-0 Phase 2 Trigger (SOLAR OVERDRIVE at 50% HP!)
  if (e.isBoss && e.bossPhase === 1 && e.hp > 0 && e.hp <= e.maxHp * 0.5) {
    e.bossPhase = 2;
    storyPhase = 1;
    player.hitStop = 0.2;
    player.trauma = Math.min(1, player.trauma + 0.85);
    audio.playBossSiren();
    spawnExplosion(e.x, getTerrainHeight(e.x, e.z) + 3.0, e.z, true);
    bossBarEl.classList.add("overdrive");
    bossPhaseEl.textContent = "SOLAR OVERDRIVE";
    // Vanguard-OS overrides limiters: full cells + cooldown reset!
    player.cells = player.maxCells;
    player.squadCd = Math.min(player.squadCd, 2);
    player.podCd = Math.min(player.podCd, 2);
    spawnEnemyUnit(e.x - 14, e.z + 10, false, 78);
    spawnEnemyUnit(e.x + 14, e.z + 10, false, 78);
    showCallout("WARDEN VEX // SOLAR OVERDRIVE ENGAGED!");
    enqueueRadio(CHAPTERS[4].twistComms, true);
  }

  if (e.hp <= 0) {
    const ey = getTerrainHeight(e.x, e.z);
    spawnExplosion(e.x, ey, e.z, true);
    audio.playHit(true);
    player.kills += 1;
    player.score += e.isBoss ? 2200 : e.heavy ? 250 : 140;
    spawnCore(e.x, e.z);

    if (e.isBoss) {
      // Dramatic multi-explosion dreadnought finisher!
      player.hitStop = 0.28;
      player.trauma = 1.0;
      bossFillEl.style.width = "0%";
      spawnExplosion(e.x - 2.6, ey + 3.2, e.z + 1.5, true);
      spawnExplosion(e.x + 2.4, ey + 2.5, e.z - 1.8, true);
      window.setTimeout(() => spawnExplosion(e.x, ey + 4.0, e.z, true), 260);
    }

    scene.remove(e.rig.group);
    e.hpEl.remove();
    const idx = enemies.indexOf(e);
    if (idx !== -1) enemies.splice(idx, 1);

    if (lockedEnemyId === e.id) {
      lockedEnemyId = enemies[0]?.id ?? null;
    }

    if (gameMode === "story") {
      const ch = CHAPTERS[campaign.chapterIdx];
      if (ch.objectiveType === "recon_and_cores" && storyPhase === 0) {
        storyKillsCount += 1;
        updateStoryObjectiveHUD(
          "Eliminate Crimson Recon Vanguard",
          `${storyKillsCount} / ${storyKillsNeeded}`,
          (storyKillsCount / Math.max(1, storyKillsNeeded)) * 100,
          "Clear all scouts to decrypt their relay core coordinates"
        );
        if (enemies.length === 0) {
          storyPhase = 1;
          storyCoresCollected = 0;
          storyCoresTotal = 3;
          spawnMissionCore(-34, -22, "CORE A");
          spawnMissionCore(32, -32, "CORE B");
          spawnMissionCore(-4, -56, "CORE C");
          spawnEnemyUnit(-28, -42, false, 64);
          spawnEnemyUnit(28, -44, false, 64);
          spawnEnemyUnit(0, -64, true, 110);
          updateStoryObjectiveHUD("Recover 3 Helios Relay Cores", "0 / 3", 0, "Morph to Car [T] to sprint between emerald beacons!");
          showCallout("MID-MISSION TWIST // RECOVER 3 RELAY CORES");
          enqueueRadio(ch.twistComms, true);
        }
      } else if (e.isBoss) {
        bossBarEl.classList.add("hidden");
        updateStoryObjectiveHUD("SOLARIS-0 Neutralized!", "COMPLETE", 100, "Sector 09 secured!");
        completeStoryChapter();
      }
    } else {
      if (enemies.length === 0) {
        player.wave += 1;
        player.hull = Math.min(player.maxHull, player.hull + 30);
        spawnWave(player.wave);
      } else {
        const label = WAVE_TITLES[(player.wave - 1) % WAVE_TITLES.length];
        waveSubEl.textContent = `${label} · ${enemies.length} on the field`;
      }
    }
  } else {
    audio.playHit(false);
  }
}

function damagePlayer(amount: number) {
  const mitigated = bracing ? amount * 0.3 : amount;
  if (player.plate > 0) {
    const absorb = Math.min(player.plate, mitigated * 0.72);
    player.plate -= absorb;
    player.hull -= mitigated - absorb;
  } else {
    player.hull -= mitigated;
  }
  player.trauma = Math.min(1, player.trauma + 0.18);
  if (player.hull <= 0 && !player.paused) {
    player.hull = 0;
    spawnExplosion(player.x, getTerrainHeight(player.x, player.z), player.z, true);
    if (gameMode === "story") {
      failStoryChapter("DUNEFALL // CHASSIS DESTROYED");
      return;
    }

    player.paused = true;
    firing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    goTitleEl.textContent = "DUNEFALL // UNIT DOWN";
    goWaveLblEl.textContent = "WAVE";
    btnPlayAgain.textContent = "Deploy Again";
    goScoreEl.textContent = Math.max(0, Math.round(player.score)).toLocaleString();
    goWaveEl.textContent = String(Math.max(1, Math.round(player.wave)));
    goKillsEl.textContent = String(Math.max(0, Math.round(player.kills)));
    gameOverModal.classList.remove("hidden");
    submitStartNgStats(goRankEl);
  }
}

// Initialize cinematic opening backdrop, pre-warm WebGL shaders safely, and open Command Mode Select!
resetBattlefield();
syncSettingsUI();
openModeMenu();
try {
  renderer.compile(scene, camera);
} catch {
  // Shader compile fallback on constrained GPU contexts
}
window.setTimeout(() => aimHintEl.classList.add("hidden"), 5500);
Object.assign(window, {
  renderer,
  scene,
  camera,
  __dunefall: {
    player,
    enemies,
    allyCars,
    terrain,
    campaign,
    getMode: () => gameMode,
    startStoryChapter,
    startEndlessMode,
    openModeMenu,
    missionCores,
    relayTowers,
    artilleryPylons,
    getConvoy: () => convoy,
  },
});

// ── 11. Main Simulation & Rendering Loop (THREE.Timer + Real-Time Shake) ─────
const timer = new THREE.Timer();
timer.connect(document);

const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpNorm = new THREE.Vector3();
const upVec = new THREE.Vector3(0, 1, 0);
const carTiltQ = new THREE.Quaternion();
const yawQ = new THREE.Quaternion();
const camPosTarget = new THREE.Vector3();
const camLook = new THREE.Vector3();

let elapsed = 0;
let realTime = 0;
let fpsFrames = 0;
let fpsAccum = 0;

renderer.setAnimationLoop(() => {
  timer.update();
  const realDt = Math.min(Math.max(timer.getDelta(), 0), 0.1);
  realTime += realDt;

  // FPS & accurate triangle readout
  fpsFrames++;
  fpsAccum += realDt;
  if (fpsAccum >= 0.5) {
    const fps = Math.round(fpsFrames / fpsAccum);
    const tris = Math.round(renderer.info.render.triangles / 1000);
    perfBadgeEl.textContent = `R180 · WEBGL · ${fps} FPS · ${tris}k TRIS`;
    fpsFrames = 0;
    fpsAccum = 0;
  }

  // Radio comms timer & post-clear chapter transition beat
  if (!menuOpen && activeRadio) {
    radioTimer -= realDt;
    if (radioTimer <= 0) advanceRadio();
  }
  if (chapterTransitionTimer > 0 && !player.paused) {
    chapterTransitionTimer -= realDt;
    if (chapterTransitionTimer <= 0) {
      if (pendingVictory) {
        pendingVictory = false;
        showVictoryScreen();
      } else if (pendingNextChapterIdx !== null) {
        const nextIdx = pendingNextChapterIdx;
        openChapterBriefing(campaign.chapterIdx, nextIdx);
      }
    }
  }

  // Hit-stop scales simulation dt while keeping camera shake decaying in real time!
  let simDt = player.paused ? 0 : realDt;
  if (player.hitStop > 0 && !player.paused) {
    player.hitStop = Math.max(0, player.hitStop - realDt);
    simDt *= 0.08;
  }
  elapsed += simDt;

  if (!player.paused) {
    if (gameMode === "story" && storyPhase < 2) {
      campaign.totalTime += simDt;
      campaign.chapterTime += simDt;
    }

    // ── A. Player Movement, Stance Morph & Car Physics ──
    player.morph += (player.targetMorph - player.morph) * (1 - Math.exp(-8.5 * simDt));
    const targetSiege = player.stance === "siege" ? 1 : 0;
    player.siege += (targetSiege - player.siege) * (1 - Math.exp(-9 * simDt));

    const fwdIn =
      (keys.has("w") || keys.has("arrowup") || touchMove.up ? 1 : 0) -
      (keys.has("s") || keys.has("arrowdown") || touchMove.down ? 1 : 0);
    const rightIn =
      (keys.has("d") || keys.has("arrowright") || touchMove.right ? 1 : 0) -
      (keys.has("a") || keys.has("arrowleft") || touchMove.left ? 1 : 0);

    const isCar = player.morph > 0.5;
    const speedMult = gameMode === "story" ? campaign.speedMult : 1;
    const baseSpeed = (isCar ? 27.5 : player.stance === "siege" ? 6.5 : 13.5) * speedMult;

    let wantVx = 0;
    let wantVz = 0;
    if (player.dashTimer > 0) {
      player.dashTimer = Math.max(0, player.dashTimer - simDt);
      wantVx = player.dashDirX * 34;
      wantVz = player.dashDirZ * 34;
      if (Math.random() < 0.7) {
        spawnParticle(player.x, getTerrainHeight(player.x, player.z) + 0.8, player.z, 0, 0.8, 0, 0xffa63d, 0.9, 0.15, 0.25, -4, true);
      }
    } else if (fwdIn !== 0 || rightIn !== 0) {
      const fX = -Math.sin(player.camYaw);
      const fZ = -Math.cos(player.camYaw);
      const rX = Math.cos(player.camYaw);
      const rZ = -Math.sin(player.camYaw);
      const len = Math.hypot(fwdIn, rightIn) || 1;
      wantVx = ((fX * fwdIn + rX * rightIn) / len) * baseSpeed;
      wantVz = ((fZ * fwdIn + rZ * rightIn) / len) * baseSpeed;
    }

    const accel = isCar ? 5.2 : 10.5;
    player.vx += (wantVx - player.vx) * (1 - Math.exp(-accel * simDt));
    player.vz += (wantVz - player.vz) * (1 - Math.exp(-accel * simDt));
    player.x += player.vx * simDt;
    player.z += player.vz * simDt;

    [player.x, player.z] = pushOutOfMesas(player.x, player.z, isCar ? 2.4 : 1.85);

    const speed = Math.hypot(player.vx, player.vz);
    if (speed > 0.7) {
      const moveYaw = Math.atan2(-player.vx, -player.vz);
      const targetBodyYaw = isCar ? moveYaw : player.camYaw;
      const diff = Math.atan2(Math.sin(targetBodyYaw - player.yaw), Math.cos(targetBodyYaw - player.yaw));
      player.yaw += diff * (1 - Math.exp(-(isCar ? 7.5 : 10) * simDt));
      player.walkCycle += simDt * speed * 0.72;

      // Kick up desert dust & occasional hot sparks beneath mech feet / 6x6 car tyres!
      if (Math.random() < (isCar ? 0.55 : 0.25)) {
        const py = getTerrainHeight(player.x, player.z);
        spawnParticle(
          player.x + (Math.random() - 0.5) * 1.6,
          py + 0.35,
          player.z + (Math.random() - 0.5) * 1.6,
          -player.vx * 0.15,
          1.2 + Math.random() * 1.1,
          -player.vz * 0.15,
          0xa68462,
          0.9,
          2.8,
          0.65,
          -0.6,
          false
        );
      }
    } else if (!isCar) {
      const diff = Math.atan2(Math.sin(player.camYaw - player.yaw), Math.cos(player.camYaw - player.yaw));
      player.yaw += diff * (1 - Math.exp(-7 * simDt));
    }

    // Cooldowns, Heat dissipation, Plate & Cell regeneration
    player.fireCd = Math.max(0, player.fireCd - simDt);
    player.missileCd = Math.max(0, player.missileCd - simDt);
    player.squadCd = Math.max(0, player.squadCd - simDt);
    player.podCd = Math.max(0, player.podCd - simDt);
    player.recoilL = Math.max(0, player.recoilL - simDt * 6.5);
    player.recoilR = Math.max(0, player.recoilR - simDt * 6.5);

    const coolRate = player.overheated ? 26 : firing ? 8 : 34;
    player.heat = Math.max(0, player.heat - coolRate * simDt);
    if (player.overheated && player.heat <= 28) player.overheated = false;

    const plateRegen = (player.weaponSlot === 1 ? 14 : 6.5) + player.upPlate * 1.5;
    if (!bracing) player.plate = Math.min(player.maxPlate, player.plate + plateRegen * simDt);

    if (player.cells < player.maxCells) {
      player.cellRegen += simDt;
      if (player.cellRegen >= 2.2) {
        player.cellRegen = 0;
        player.cells++;
      }
    }

    // Compute world aim point (auto-assists softly toward locked enemy if within crosshair cone!)
    const locked = getLockedEnemy();
    const camDirX = -Math.sin(player.camYaw) * Math.cos(player.camPitch);
    const camDirY = -Math.sin(player.camPitch);
    const camDirZ = -Math.cos(player.camYaw) * Math.cos(player.camPitch);
    tmpAim.set(
      player.x + camDirX * 85,
      Math.max(getTerrainHeight(player.x + camDirX * 60, player.z + camDirZ * 60) + 1.4, getTerrainHeight(player.x, player.z) + 3.2 + camDirY * 60),
      player.z + camDirZ * 85
    );
    if (locked) {
      const ly = getTerrainHeight(locked.x, locked.z) + 2.4;
      tmpV1.set(locked.x - player.x, ly - (getTerrainHeight(player.x, player.z) + 3.2), locked.z - player.z).normalize();
      const dot = tmpV1.x * camDirX + tmpV1.y * camDirY + tmpV1.z * camDirZ;
      if (dot > 0.86) tmpAim.set(locked.x, ly, locked.z);
    }

    // ── B. Primary Weapon Firing (LMB) ──
    if (firing && !player.overheated && player.fireCd <= 0 && !player.studioMode) {
      const w = WEAPONS[player.weaponSlot];
      const siegeMult = player.stance === "siege" ? 1.45 : 1.0;
      const tierMult = (1 + (player.tier - 1) * 0.18 + (player.upRail - 1) * 0.1) * (gameMode === "story" ? campaign.damageMult : 1);

      player.fireCd = w.cooldown / siegeMult;
      player.heat = Math.min(100, player.heat + w.heat * (player.stance === "siege" ? 0.78 : 1));
      if (player.heat >= 100) {
        player.overheated = true;
        showCallout("WEAPONS OVERHEATED · VENTING");
      }
      player.shots++;
      player.trauma = Math.min(1, player.trauma + w.trauma);
      audio.playGun(player.weaponSlot);

      const sides: (0 | 1)[] = w.dual ? [0, 1] : [player.barrelSide];
      player.barrelSide = player.barrelSide === 0 ? 1 : 0;

      for (const s of sides) {
        if (s === 0) player.recoilL = 1;
        else player.recoilR = 1;

        playerRig.getMuzzleWorldPos(s, tmpV1);
        tmpV2.copy(tmpAim).sub(tmpV1).normalize();
        tmpV2.x += (Math.random() - 0.5) * w.spread;
        tmpV2.y += (Math.random() - 0.5) * w.spread;
        tmpV2.z += (Math.random() - 0.5) * w.spread;
        tmpV2.normalize();

        spawnProjectile({
          x: tmpV1.x,
          y: tmpV1.y,
          z: tmpV1.z,
          dirX: tmpV2.x,
          dirY: tmpV2.y,
          dirZ: tmpV2.z,
          speed: w.speed,
          damage: w.damage * siegeMult * tierMult,
          color: w.color,
          friendly: true,
          splash: w.splash,
          length: w.length,
          gravity: player.weaponSlot === 4 ? -28 : 0,
        });
      }
    }

    // ── C. Update Player 3D Rig on Dunes (Car conforms to dune slope!) ──
    const py = getTerrainHeight(player.x, player.z);
    playerRig.root.position.set(player.x, py, player.z);
    yawQ.setFromAxisAngle(upVec, player.yaw);
    if (player.morph > 0.05) {
      getTerrainNormal(player.x, player.z, tmpNorm);
      carTiltQ.setFromUnitVectors(upVec, tmpNorm).multiply(yawQ);
      playerRig.root.quaternion.copy(yawQ).slerp(carTiltQ, player.morph);
    } else {
      playerRig.root.quaternion.copy(yawQ);
    }

    const aimOffset = Math.atan2(Math.sin(player.camYaw - player.yaw), Math.cos(player.camYaw - player.yaw));
    playerRig.updateVisuals({
      morph: player.morph,
      siege: player.siege,
      walkCycle: player.walkCycle,
      moveAmt: Math.min(1, speed / 10),
      speed,
      aimYawOffset: aimOffset,
      aimPitch: -player.camPitch * 0.65,
      bracing,
      dashTimer: player.dashTimer,
      recoilL: player.recoilL,
      recoilR: player.recoilR,
      dt: simDt,
    });

    // ── D. Enemy War Robots & Boss SOLARIS-0 AI, Firing & Solid Collision ──
    for (const e of enemies) {
      // In Chapter 3 (Convoy), Crimson raiders prioritize ATLAS-6 if closer than the player
      let tgtX = player.x;
      let tgtZ = player.z;
      let tgtY = py + 2.1;
      if (convoy && !e.isBoss) {
        const dPlayer = Math.hypot(player.x - e.x, player.z - e.z);
        const dConvoy = Math.hypot(convoy.x - e.x, convoy.z - e.z);
        if (dConvoy < dPlayer + 14) {
          tgtX = convoy.x;
          tgtZ = convoy.z;
          tgtY = getTerrainHeight(convoy.x, convoy.z) + 2.0;
        }
      }

      const dxP = tgtX - e.x;
      const dzP = tgtZ - e.z;
      const distP = Math.hypot(dxP, dzP) || 1;

      if (!player.freezeEnemies) {
        const targetYaw = Math.atan2(-dxP, -dzP);
        const yDiff = Math.atan2(Math.sin(targetYaw - e.yaw), Math.cos(targetYaw - e.yaw));
        e.yaw += yDiff * (1 - Math.exp(-(e.isBoss ? 4.4 : 3.6) * simDt));

        const isOverdrive = e.isBoss && e.bossPhase === 2;
        const moveSpd = e.isBoss ? (isOverdrive ? 7.6 : 5.2) : e.heavy ? 4.4 : 6.2;
        const idealMax = e.isBoss ? 42 : 34;
        const idealMin = e.isBoss ? 22 : 18;
        const approach = distP > idealMax ? 1 : distP < idealMin ? -0.55 : 0.1;
        const fwdX = dxP / distP;
        const fwdZ = dzP / distP;
        const stX = -fwdZ * e.strafeDir * (e.isBoss ? 0.65 : 0.45);
        const stZ = fwdX * e.strafeDir * (e.isBoss ? 0.65 : 0.45);
        e.x += (fwdX * approach + stX) * moveSpd * simDt;
        e.z += (fwdZ * approach + stZ) * moveSpd * simDt;
        e.walkCycle += simDt * moveSpd * (e.isBoss ? 0.42 : 0.7);

        // Fire bursts (Boss SOLARIS-0 fires twin/triple plasma rail fans + Solar Barrage!)
        e.fireCd -= simDt;
        if (e.fireCd <= 0 && distP < (e.isBoss ? 96 : 78)) {
          if (e.isBoss) {
            e.fireCd = isOverdrive ? 1.05 : 1.55;
            e.rig.muzzle.getWorldPosition(tmpV1);
            const baseYaw = Math.atan2(tgtX - tmpV1.x, tgtZ - tmpV1.z);
            const shots = isOverdrive ? [-0.14, 0, 0.14] : [-0.06, 0.06];
            for (const spread of shots) {
              const ang = baseYaw + spread;
              const horizD = Math.hypot(tgtX - tmpV1.x, tgtZ - tmpV1.z) || 1;
              const dy = (tgtY - tmpV1.y) / horizD;
              tmpV2.set(Math.sin(ang), dy, Math.cos(ang)).normalize();
              spawnProjectile({
                x: tmpV1.x,
                y: tmpV1.y,
                z: tmpV1.z,
                dirX: tmpV2.x,
                dirY: tmpV2.y,
                dirZ: tmpV2.z,
                speed: isOverdrive ? 76 : 64,
                damage: isOverdrive ? 15 : 12,
                color: 0xff6b35,
                friendly: false,
                length: 4.2,
              });
            }
          } else {
            e.fireCd = (e.heavy ? 1.45 : 1.85) + Math.random() * 0.7;
            e.rig.muzzle.getWorldPosition(tmpV1);
            tmpV2.set(tgtX - tmpV1.x, tgtY - tmpV1.y, tgtZ - tmpV1.z).normalize();
            tmpV2.x += (Math.random() - 0.5) * 0.06;
            tmpV2.z += (Math.random() - 0.5) * 0.06;
            tmpV2.normalize();
            spawnProjectile({
              x: tmpV1.x,
              y: tmpV1.y,
              z: tmpV1.z,
              dirX: tmpV2.x,
              dirY: tmpV2.y,
              dirZ: tmpV2.z,
              speed: 58,
              damage: e.heavy ? 13 : 8,
              color: 0xff4040,
              friendly: false,
              length: 2.6,
            });
          }
        }

        // Boss Solar Barrage telegraphed ground strikes!
        if (e.isBoss && e.barrageCd !== undefined) {
          e.barrageCd -= simDt;
          if (e.barrageCd <= 0) {
            e.barrageCd = isOverdrive ? 4.4 : 6.4;
            const ringCount = isOverdrive ? 2 : 1;
            for (let r = 0; r < ringCount; r++) {
              const rx = player.x + (r === 0 ? player.vx * 0.5 : (Math.random() - 0.5) * 16);
              const rz = player.z + (r === 0 ? player.vz * 0.5 : (Math.random() - 0.5) * 16);
              spawnDangerRing(rx, rz, isOverdrive ? 7.5 : 6.5, 1.65, isOverdrive ? 32 : 24);
            }
          }
        }
      }

      if (e.solarCore) e.solarCore.rotation.y += simDt * (e.bossPhase === 2 ? 6.5 : 2.2);
      if (e.overdriveAura) {
        const mat = e.overdriveAura.material as THREE.MeshBasicMaterial;
        mat.opacity = e.bossPhase === 2 ? 0.45 + Math.sin(elapsed * 8) * 0.25 : 0;
        e.overdriveAura.rotation.z += simDt * 1.8;
      }

      [e.x, e.z] = pushOutOfMesas(e.x, e.z, e.isBoss ? 4.2 : e.heavy ? 2.4 : 1.9);

      // Solid collision with Player (high-speed Car ramming deals massive damage + knockback!)
      const pMinDist = (isCar ? 2.5 : 2.1) + (e.isBoss ? 3.8 : e.heavy ? 2.2 : 1.8);
      const pdx = player.x - e.x;
      const pdz = player.z - e.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < pMinDist && pd > 1e-4) {
        const push = pMinDist - pd;
        const nx = pdx / pd;
        const nz = pdz / pd;
        player.x += nx * push * 0.55;
        player.z += nz * push * 0.55;
        e.x -= nx * push * 0.45;
        e.z -= nz * push * 0.45;
        if (isCar && speed > 14) {
          damageEnemy(e, 34);
          spawnSparkBurst((player.x + e.x) * 0.5, py + 1.4, (player.z + e.z) * 0.5, 14, 0xffd27a, 14);
          player.trauma = Math.min(1, player.trauma + 0.28);
          e.x -= nx * 3.2;
          e.z -= nz * 3.2;
        }
      }

      // Enemy-to-enemy solid separation
      for (const other of enemies) {
        if (other === e) continue;
        const odx = e.x - other.x;
        const odz = e.z - other.z;
        const od = Math.hypot(odx, odz);
        if (od < 4.4 && od > 1e-4) {
          const push = (4.4 - od) * 0.5;
          e.x += (odx / od) * push;
          e.z += (odz / od) * push;
        }
      }

      e.rig.group.position.set(e.x, getTerrainHeight(e.x, e.z), e.z);
      e.rig.group.rotation.y = e.yaw;
      const sw = Math.sin(e.walkCycle) * 0.48;
      e.rig.leftLeg.rotation.x = sw;
      e.rig.rightLeg.rotation.x = -sw;
      e.hitFlash = Math.max(0, e.hitFlash - simDt);
    }

    // ── E. Allied 6-Wheel Combat Cars, Hover Drones & Missile Pods ──
    for (let i = allyCars.length - 1; i >= 0; i--) {
      const c = allyCars[i];
      c.life -= simDt;
      if (c.life <= 0) {
        scene.remove(c.rig.group);
        allyCars.splice(i, 1);
        continue;
      }
      c.orbitAngle += simDt * 0.42;
      const targetX = player.x + Math.cos(c.orbitAngle) * 11.5;
      const targetZ = player.z + Math.sin(c.orbitAngle) * 11.5;
      const dx = targetX - c.x;
      const dz = targetZ - c.z;
      const dist = Math.hypot(dx, dz);
      const wantSpd = dist > 3 ? Math.min(18, dist * 1.4) : 0;
      c.speed += (wantSpd - c.speed) * (1 - Math.exp(-4 * simDt));
      if (dist > 0.5) {
        const tyaw = Math.atan2(-dx, -dz);
        const yd = Math.atan2(Math.sin(tyaw - c.yaw), Math.cos(tyaw - c.yaw));
        c.yaw += yd * (1 - Math.exp(-5 * simDt));
      }
      c.x -= Math.sin(c.yaw) * c.speed * simDt;
      c.z -= Math.cos(c.yaw) * c.speed * simDt;
      [c.x, c.z] = pushOutOfMesas(c.x, c.z, 2.3);

      // Solid separation from player so wingman car never clips through you!
      const pdx = c.x - player.x;
      const pdz = c.z - player.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < 4.6 && pd > 1e-4) {
        c.x += (pdx / pd) * (4.6 - pd);
        c.z += (pdz / pd) * (4.6 - pd);
      }

      const cy = getTerrainHeight(c.x, c.z);
      c.rig.group.position.set(c.x, cy, c.z);
      getTerrainNormal(c.x, c.z, tmpNorm);
      yawQ.setFromAxisAngle(upVec, c.yaw);
      c.rig.group.quaternion.setFromUnitVectors(upVec, tmpNorm).multiply(yawQ);
      for (const w of c.rig.wheels) w.rotation.x -= (c.speed / 0.52) * simDt;

      // Auto-engage nearest enemy mech!
      c.fireCd -= simDt;
      if (c.fireCd <= 0 && enemies.length > 0) {
        const target = enemies[i % enemies.length];
        if (Math.hypot(target.x - c.x, target.z - c.z) < 75) {
          c.fireCd = 0.72;
          tmpV2.set(target.x - c.x, getTerrainHeight(target.x, target.z) + 2.2 - (cy + 1.5), target.z - c.z).normalize();
          spawnProjectile({
            x: c.x,
            y: cy + 1.5,
            z: c.z,
            dirX: tmpV2.x,
            dirY: tmpV2.y,
            dirZ: tmpV2.z,
            speed: 95,
            damage: 11,
            color: 0x4ade80,
            friendly: true,
            length: 2.2,
          });
        }
      }
    }

    for (let i = allyDrones.length - 1; i >= 0; i--) {
      const d = allyDrones[i];
      d.life -= simDt;
      if (d.life <= 0) {
        scene.remove(d.mesh);
        allyDrones.splice(i, 1);
        continue;
      }
      d.orbitAngle += simDt * 1.15;
      const tx = player.x + Math.cos(d.orbitAngle) * 7.5;
      const tz = player.z + Math.sin(d.orbitAngle) * 7.5;
      d.x += (tx - d.x) * (1 - Math.exp(-3.5 * simDt));
      d.z += (tz - d.z) * (1 - Math.exp(-3.5 * simDt));
      d.y = getTerrainHeight(d.x, d.z) + 6.4 + Math.sin(elapsed * 3.5 + i) * 0.45;
      d.mesh.position.set(d.x, d.y, d.z);
      d.mesh.rotation.y = -d.orbitAngle;

      d.fireCd -= simDt;
      if (d.fireCd <= 0 && enemies.length > 0) {
        const target = enemies[0];
        d.fireCd = 0.48;
        tmpV2.set(target.x - d.x, getTerrainHeight(target.x, target.z) + 2.2 - d.y, target.z - d.z).normalize();
        spawnProjectile({
          x: d.x,
          y: d.y - 0.2,
          z: d.z,
          dirX: tmpV2.x,
          dirY: tmpV2.y,
          dirZ: tmpV2.z,
          speed: 110,
          damage: 9,
          color: 0x86efac,
          friendly: true,
          length: 2.4,
        });
      }
    }

    for (let i = missilePods.length - 1; i >= 0; i--) {
      const pod = missilePods[i];
      pod.life -= simDt;
      if (pod.life <= 0) {
        scene.remove(pod.rig.group);
        missilePods.splice(i, 1);
        continue;
      }
      pod.rig.turret.rotation.y += simDt * 1.4;
      pod.fireCd -= simDt;
      if (pod.fireCd <= 0 && enemies.length > 0) {
        pod.fireCd = 1.35;
        const target = enemies[Math.floor(Math.random() * enemies.length)];
        audio.playMissile();
        spawnProjectile({
          x: pod.x,
          y: getTerrainHeight(pod.x, pod.z) + 1.8,
          z: pod.z,
          dirX: (Math.random() - 0.5) * 0.4,
          dirY: 0.92,
          dirZ: (Math.random() - 0.5) * 0.4,
          speed: 42,
          damage: 34 + player.upPods * 6,
          color: 0xf59e0b,
          friendly: true,
          splash: 4.5,
          isMissile: true,
          homingTarget: target,
        });
      }
    }

    // ── F. Glowing Emerald Energy Core Pickups (Tier & Upgrade Progression!) ──
    for (let i = energyCores.length - 1; i >= 0; i--) {
      const co = energyCores[i];
      co.bob += simDt * 3.0;
      co.rig.cube.rotation.y += simDt * 2.2;
      co.rig.cube.position.y = 0.95 + Math.sin(co.bob) * 0.22;

      const dist = Math.hypot(player.x - co.x, player.z - co.z);
      // Gentle magnetic pull within 7m
      if (dist < 7.5 && dist > 0.1) {
        co.x += ((player.x - co.x) / dist) * 14 * simDt;
        co.z += ((player.z - co.z) / dist) * 14 * simDt;
        co.rig.group.position.set(co.x, getTerrainHeight(co.x, co.z), co.z);
      }
      if (dist < 2.9) {
        audio.playCorePickup();
        scene.remove(co.rig.group);
        energyCores.splice(i, 1);
        player.cores++;
        player.score += 75;
        player.hull = Math.min(player.maxHull, player.hull + 15);
        player.cells = Math.min(player.maxCells, player.cells + 2);
        spawnSparkBurst(player.x, py + 1.8, player.z, 10, 0x4ade80, 9);

        if (player.cores >= player.coresNeeded) {
          player.cores = 0;
          player.tier = Math.min(5, player.tier + 1);
          player.coresNeeded = 4 + player.tier;
          player.upRail = Math.min(5, player.upRail + 1);
          player.upPods = Math.min(5, player.upPods + 1);
          player.upPlate = Math.min(5, player.upPlate + 1);
          player.maxHull += 20;
          player.hull = player.maxHull;
          player.maxPlate += 15;
          player.plate = player.maxPlate;
          showCallout(`TIER ${player.tier} REACHED · RAIL, PODS & PLATE UPGRADED`);
        }
      }
    }

    // ── F2. Story Mode Objectives (Cores, Relays, ATLAS-6 Convoy, Pylons & Danger Rings) ──
    if (gameMode === "story" && storyPhase < 2) {
      const ch = CHAPTERS[campaign.chapterIdx];

      // Chapter 1: Encrypted Relay Cores
      for (let i = missionCores.length - 1; i >= 0; i--) {
        const mc = missionCores[i];
        mc.bob += simDt * 3.2;
        mc.rig.cube.rotation.y += simDt * 2.8;
        mc.rig.cube.position.y = 1.35 + Math.sin(mc.bob) * 0.25;
        mc.rig.ring.rotation.z += simDt * 1.4;

        const dist = Math.hypot(player.x - mc.x, player.z - mc.z);
        if (dist < 4.2) {
          audio.playCorePickup();
          scene.remove(mc.rig.group);
          mc.wpEl.remove();
          missionCores.splice(i, 1);
          storyCoresCollected += 1;
          player.score += 220;
          player.hull = Math.min(player.maxHull, player.hull + 20);
          spawnSparkBurst(player.x, py + 1.8, player.z, 16, 0x4ade80, 12);
          updateStoryObjectiveHUD(
            "Recover 3 Helios Relay Cores",
            `${storyCoresCollected} / ${storyCoresTotal}`,
            (storyCoresCollected / Math.max(1, storyCoresTotal)) * 100,
            missionCores.length > 0 ? `${missionCores.length} beacon(s) remaining on radar` : "All Helios Relay Cores secured!"
          );
          if (storyCoresCollected >= storyCoresTotal) {
            completeStoryChapter();
          }
        }
      }

      // Chapter 2: Helios Relay Towers Capture & Hold
      if (ch.objectiveType === "capture_relays" && relayTowers.length > 0) {
        let capturedCount = 0;
        let activeCapturePct = 0;
        let inAnyRing = false;

        for (const rt of relayTowers) {
          rt.rig.spinner.rotation.y += simDt * (rt.captured ? 3.2 : 1.0);
          if (rt.captured) {
            capturedCount += 1;
            continue;
          }
          const d = Math.hypot(player.x - rt.x, player.z - rt.z);
          const inside = d <= rt.radius;
          if (inside) {
            inAnyRing = true;
            rt.progress = Math.min(100, rt.progress + simDt * 13.5);
            activeCapturePct = Math.max(activeCapturePct, rt.progress);
            rt.rig.ringMat.color.setHex(0x4ade80);
            rt.rig.fillDisc.scale.setScalar(Math.max(0.05, rt.progress / 100));

            if (rt.progress >= 100) {
              rt.captured = true;
              capturedCount += 1;
              rt.rig.skyBeamMat.opacity = 0.44;
              (rt.rig.dishCore.material as THREE.MeshStandardMaterial).emissive.setHex(0x22c55e);
              (rt.rig.dishCore.material as THREE.MeshStandardMaterial).color.setHex(0x86efac);
              rt.wpEl.className = "world-wp green";
              rt.label = `${rt.label} ONLINE`;
              audio.playObjectiveComplete();
              player.hull = Math.min(player.maxHull, player.hull + 35);
              player.score += 350;
              spawnSparkBurst(rt.x, getTerrainHeight(rt.x, rt.z) + 3.5, rt.z, 22, 0x4ade80, 14);
              showCallout(`${rt.label} · +35 HULL RESTORED`);

              if (capturedCount === 1 && storyPhase === 0) {
                storyPhase = 1;
                enqueueRadio(ch.twistComms, true);
                const other = relayTowers.find((t) => !t.captured);
                if (other) {
                  spawnEnemyUnit(other.x - 10, other.z - 8, true, 130);
                  spawnEnemyUnit(other.x + 10, other.z - 8, true, 130);
                  spawnEnemyUnit(other.x, other.z + 12, false, 78);
                }
              }
            }
          } else {
            rt.rig.ringMat.color.setHex(0xf5b942);
          }
        }

        const totalPct = ((capturedCount * 100 + (inAnyRing ? activeCapturePct : 0)) / (relayTowers.length * 100)) * 100;
        updateStoryObjectiveHUD(
          "Capture Helios Relay Towers",
          `${capturedCount} / ${relayTowers.length}`,
          totalPct,
          inAnyRing ? `UPLINKING RELAY · ${Math.round(activeCapturePct)}% (HOLD RING!)` : "Move inside a glowing relay ring to capture"
        );

        if (capturedCount >= relayTowers.length) {
          completeStoryChapter();
        } else if (!player.freezeEnemies) {
          storyReinforceTimer -= simDt;
          if (storyReinforceTimer <= 0 && enemies.length < 4) {
            storyReinforceTimer = 11;
            const targetTower = relayTowers.find((t) => !t.captured) ?? relayTowers[0];
            spawnEnemyUnit(targetTower.x + (Math.random() - 0.5) * 24, targetTower.z - 16, false, 74);
          }
        }
      }

      // Chapter 3: ATLAS-6 Convoy Escort
      if (ch.objectiveType === "escort_convoy" && convoy) {
        const distPlayer = Math.hypot(player.x - convoy.x, player.z - convoy.z);
        const boosted = distPlayer <= 24;
        const [wx, wz] = convoy.waypoints[convoy.waypointIdx];
        const dxW = wx - convoy.x;
        const dzW = wz - convoy.z;
        const dW = Math.hypot(dxW, dzW);

        if (!player.freezeEnemies) {
          const wantSpd = boosted ? 8.6 : 4.3;
          convoy.speed += (wantSpd - convoy.speed) * (1 - Math.exp(-3.5 * simDt));
          if (dW > 1.5) {
            const tyaw = Math.atan2(-dxW, -dzW);
            const yd = Math.atan2(Math.sin(tyaw - convoy.yaw), Math.cos(tyaw - convoy.yaw));
            convoy.yaw += yd * (1 - Math.exp(-3.2 * simDt));
            convoy.x -= Math.sin(convoy.yaw) * convoy.speed * simDt;
            convoy.z -= Math.cos(convoy.yaw) * convoy.speed * simDt;
            [convoy.x, convoy.z] = pushOutOfMesas(convoy.x, convoy.z, 3.6);
          } else if (convoy.waypointIdx + 1 < convoy.waypoints.length) {
            convoy.waypointIdx += 1;
          } else {
            // Reached Northern Extraction Gate!
            updateStoryObjectiveHUD("ATLAS-6 Reached Extraction Gate!", "100%", 100, "Fusion core delivered safely!");
            completeStoryChapter();
          }

          // Mid-mission ambush roadblock!
          if (!convoy.ambushSpawned && convoy.z < 6) {
            convoy.ambushSpawned = true;
            storyPhase = 1;
            enqueueRadio(ch.twistComms, true);
            spawnEnemyUnit(convoy.x - 16, convoy.z - 28, true, 128);
            spawnEnemyUnit(convoy.x + 16, convoy.z - 28, true, 128);
            spawnEnemyUnit(convoy.x - 6, convoy.z - 36, false, 78);
            spawnEnemyUnit(convoy.x + 8, convoy.z - 36, false, 78);
            showCallout("CRIMSON AMBUSH AHEAD OF ATLAS-6!");
          }

          storyReinforceTimer -= simDt;
          if (storyReinforceTimer <= 0 && enemies.length < 3 && convoy.z > -44) {
            storyReinforceTimer = 9.5;
            spawnEnemyUnit(convoy.x + (Math.random() > 0.5 ? 24 : -24), convoy.z - 24, false, 76);
          }

          // ATLAS-6 self-defense roof turret
          convoy.fireCd -= simDt;
          if (convoy.fireCd <= 0 && enemies.length > 0) {
            let nearest = enemies[0];
            let bestD = Math.hypot(nearest.x - convoy.x, nearest.z - convoy.z);
            for (const en of enemies) {
              const dd = Math.hypot(en.x - convoy.x, en.z - convoy.z);
              if (dd < bestD) {
                bestD = dd;
                nearest = en;
              }
            }
            if (bestD < 62) {
              convoy.fireCd = 0.85;
              const cy = getTerrainHeight(convoy.x, convoy.z);
              convoy.rig.turret.rotation.y = Math.atan2(-(nearest.x - convoy.x), -(nearest.z - convoy.z)) - convoy.yaw;
              tmpV2.set(nearest.x - convoy.x, getTerrainHeight(nearest.x, nearest.z) + 2.2 - (cy + 3.0), nearest.z - convoy.z).normalize();
              spawnProjectile({
                x: convoy.x,
                y: cy + 3.0,
                z: convoy.z,
                dirX: tmpV2.x,
                dirY: tmpV2.y,
                dirZ: tmpV2.z,
                speed: 98,
                damage: 14,
                color: 0x4ade80,
                friendly: true,
                length: 2.4,
              });
            }
          }
        }

        const cy = getTerrainHeight(convoy.x, convoy.z);
        convoy.rig.group.position.set(convoy.x, cy, convoy.z);
        getTerrainNormal(convoy.x, convoy.z, tmpNorm);
        yawQ.setFromAxisAngle(upVec, convoy.yaw);
        convoy.rig.group.quaternion.setFromUnitVectors(upVec, tmpNorm).multiply(yawQ);
        for (const w of convoy.rig.wheels) w.rotation.x -= (convoy.speed / 0.84) * simDt;
        convoy.rig.auraMat.opacity = boosted ? 0.45 : 0.14;

        const routePct = Math.max(0, Math.min(100, ((40 - convoy.z) / 96) * 100));
        const hpPct = Math.max(0, Math.round((convoy.hp / convoy.maxHp) * 100));
        updateStoryObjectiveHUD(
          "Escort ATLAS-6 to Extraction Gate",
          `${Math.round(routePct)}%`,
          routePct,
          `ATLAS-6 HULL: ${hpPct}% · ${boosted ? "ESCORT BOOST ACTIVE" : "MOVE CLOSER TO BOOST"}`
        );
      }

      // Chapter 4: Crimson Artillery Pylons
      if (ch.objectiveType === "destroy_pylons" && artilleryPylons.length > 0) {
        for (const pyObj of artilleryPylons) {
          pyObj.rig.emitter.rotation.y += simDt * 1.9;
          pyObj.rig.core.rotation.y -= simDt * 2.5;
          pyObj.hitFlash = Math.max(0, pyObj.hitFlash - simDt);

          if (!player.freezeEnemies) {
            pyObj.fireCd -= simDt;
            if (pyObj.fireCd <= 0) {
              pyObj.fireCd = 3.8 + Math.random() * 2.2;
              const tx = player.x + player.vx * 0.45 + (Math.random() - 0.5) * 10;
              const tz = player.z + player.vz * 0.45 + (Math.random() - 0.5) * 10;
              spawnDangerRing(tx, tz, 6.5, 1.85, 26);
            }
          }
        }
        if (!player.freezeEnemies) {
          storyReinforceTimer -= simDt;
          if (storyReinforceTimer <= 0 && enemies.length < 3) {
            storyReinforceTimer = 10.5;
            const p0 = artilleryPylons[Math.floor(Math.random() * artilleryPylons.length)];
            spawnEnemyUnit(p0.x + (Math.random() - 0.5) * 14, p0.z + 10, false, 78);
          }
        }
      }

      // Chapter 5: Live Boss Objective Sync
      if (ch.objectiveType === "boss_solaris") {
        const boss = enemies.find((e) => e.isBoss);
        if (boss) {
          const hpPct = Math.max(0, (boss.hp / boss.maxHp) * 100);
          bossFillEl.style.width = `${hpPct}%`;
          updateStoryObjectiveHUD(
            "Defeat Warden Vex in SOLARIS-0",
            `${Math.ceil(hpPct)}% HP`,
            100 - hpPct,
            boss.bossPhase === 2 ? "SOLAR OVERDRIVE · DODGE MORTAR BARRAGES!" : "Break SOLARIS-0 below 50% HP"
          );
        }
      }
    }

    // Telegraphed Artillery & Solar Barrage Danger Rings (Chapters 4 & 5)
    for (let i = dangerRings.length - 1; i >= 0; i--) {
      const dr = dangerRings[i];
      dr.timer += simDt;
      const t = Math.min(1, dr.timer / dr.maxTime);
      dr.rig.inner.scale.setScalar(Math.max(0.05, t));
      dr.rig.innerMat.opacity = 0.18 + t * 0.48;
      if (dr.timer >= dr.maxTime) {
        const gy = getTerrainHeight(dr.x, dr.z);
        spawnExplosion(dr.x, gy + 0.3, dr.z, true);
        const dp = Math.hypot(player.x - dr.x, player.z - dr.z);
        if (dp <= dr.radius) {
          damagePlayer(dr.damage);
        }
        scene.remove(dr.rig.group);
        dangerRings.splice(i, 1);
      }
    }

    // ── G. Projectiles, Homing Missiles & Splash Craters ──
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.life -= simDt;

      // Homing missile steering + smoke trail
      if (p.isMissile) {
        if (p.homingTarget && enemies.includes(p.homingTarget)) {
          const ty = getTerrainHeight(p.homingTarget.x, p.homingTarget.z) + 2.2;
          tmpV1.set(p.homingTarget.x - p.x, ty - p.y, p.homingTarget.z - p.z).normalize();
          const curSpd = Math.hypot(p.vx, p.vy, p.vz) || 42;
          p.vx += (tmpV1.x * curSpd - p.vx) * (1 - Math.exp(-5.5 * simDt));
          p.vy += (tmpV1.y * curSpd - p.vy) * (1 - Math.exp(-5.5 * simDt));
          p.vz += (tmpV1.z * curSpd - p.vz) * (1 - Math.exp(-5.5 * simDt));
        }
        if (Math.random() < 0.75) {
          spawnParticle(p.x, p.y, p.z, 0, 0.5, 0, 0xffd28a, 0.6, 1.8, 0.28, 0, true);
        }
      }

      p.vy += p.gravity * simDt;
      p.x += p.vx * simDt;
      p.y += p.vy * simDt;
      p.z += p.vz * simDt;
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);

      let hit = false;
      const groundY = getTerrainHeight(p.x, p.z);

      // Hit terrain
      if (p.y <= groundY + 0.15) {
        hit = true;
        if (p.splash > 0) spawnExplosion(p.x, groundY, p.z, p.splash > 5);
        else spawnSparkBurst(p.x, groundY + 0.2, p.z, 4, 0xffcc70, 7);
      }

      // Hit mesa rock cover
      if (!hit) {
        for (const m of terrain.mesas) {
          if (Math.hypot(p.x - m.x, p.z - m.z) < m.radius && p.y < getTerrainHeight(m.x, m.z) + m.height) {
            hit = true;
            spawnSparkBurst(p.x, p.y, p.z, 5, 0xffd27a, 8);
            break;
          }
        }
      }

      // Hit enemies & Artillery Pylons (friendly projectiles)
      if (!hit && p.friendly) {
        for (let ei = enemies.length - 1; ei >= 0; ei--) {
          const e = enemies[ei];
          const ey = getTerrainHeight(e.x, e.z) + (e.isBoss ? 4.2 : 2.2);
          const r = e.isBoss ? 4.5 : e.heavy ? 2.6 : 2.1;
          const h = e.isBoss ? 5.0 : 2.6;
          if (Math.hypot(p.x - e.x, p.z - e.z) < r && Math.abs(p.y - ey) < h) {
            hit = true;
            if (p.splash > 0) {
              spawnExplosion(p.x, p.y, p.z, p.splash > 5);
            } else {
              spawnSparkBurst(p.x, p.y, p.z, 7, 0xffcf70, 10);
              damageEnemy(e, p.damage);
            }
            break;
          }
        }
        if (!hit && artilleryPylons.length > 0) {
          for (let pi = artilleryPylons.length - 1; pi >= 0; pi--) {
            const pyObj = artilleryPylons[pi];
            const pgy = getTerrainHeight(pyObj.x, pyObj.z) + 4.4;
            if (Math.hypot(p.x - pyObj.x, p.z - pyObj.z) < 3.4 && Math.abs(p.y - pgy) < 5.0) {
              hit = true;
              if (p.splash > 0) {
                spawnExplosion(p.x, p.y, p.z, p.splash > 5);
              } else {
                spawnSparkBurst(p.x, p.y, p.z, 8, 0xff8866, 10);
                damagePylon(pyObj, p.damage);
              }
              break;
            }
          }
        }
      } else if (!hit && !p.friendly) {
        // Enemy projectile hitting player
        const playerY = py + (isCar ? 1.0 : 2.3);
        if (Math.hypot(p.x - player.x, p.z - player.z) < 2.3 && Math.abs(p.y - playerY) < 2.3) {
          hit = true;
          spawnSparkBurst(p.x, p.y, p.z, 8, bracing ? 0xf5b942 : 0xff5544, 9);
          damagePlayer(p.damage);
        } else if (convoy) {
          const cy = getTerrainHeight(convoy.x, convoy.z) + 1.9;
          if (Math.hypot(p.x - convoy.x, p.z - convoy.z) < 3.8 && Math.abs(p.y - cy) < 2.6) {
            hit = true;
            spawnSparkBurst(p.x, p.y, p.z, 7, 0x4ade80, 9);
            convoy.hp = Math.max(0, convoy.hp - p.damage * 0.72);
            if (convoy.hp <= 0) {
              spawnExplosion(convoy.x, cy, convoy.z, true);
              failStoryChapter("ATLAS-6 DESTROYED // CONVOY LOST");
            }
          }
        }
      }

      // Splash AoE blast damage
      if (hit && p.friendly && p.splash > 0) {
        for (let ei = enemies.length - 1; ei >= 0; ei--) {
          const e = enemies[ei];
          const d = Math.hypot(p.x - e.x, p.z - e.z);
          if (d < p.splash) {
            damageEnemy(e, p.damage * (1 - (d / p.splash) * 0.5));
          }
        }
        for (let pi = artilleryPylons.length - 1; pi >= 0; pi--) {
          const pyObj = artilleryPylons[pi];
          const d = Math.hypot(p.x - pyObj.x, p.z - pyObj.z);
          if (d < p.splash + 1.5) {
            damagePylon(pyObj, p.damage * (1 - (d / (p.splash + 1.5)) * 0.45));
          }
        }
      }

      if (hit || p.life <= 0) {
        releaseProjectile(p);
        projectiles.splice(i, 1);
      }
    }

    // ── H. Particles & Bouncing Debris Physics (Zero-GC Pooled) ──
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.life -= simDt;
      if (pt.life <= 0) {
        releaseParticle(pt);
        particles.splice(i, 1);
        continue;
      }
      pt.vy += pt.gravity * simDt;
      pt.sprite.position.x += pt.vx * simDt;
      pt.sprite.position.y += pt.vy * simDt;
      pt.sprite.position.z += pt.vz * simDt;
      const t = 1 - pt.life / pt.maxLife;
      const scVal = THREE.MathUtils.lerp(pt.startScale, pt.endScale, t);
      pt.sprite.scale.set(scVal, scVal, 1);
      pt.sprite.material.opacity = (1 - t) * 0.92;
    }

    for (let i = debris.length - 1; i >= 0; i--) {
      const db = debris[i];
      db.life -= simDt;
      if (db.life <= 0) {
        releaseDebris(db);
        debris.splice(i, 1);
        continue;
      }
      db.vy -= 24 * simDt;
      db.mesh.position.x += db.vx * simDt;
      db.mesh.position.y += db.vy * simDt;
      db.mesh.position.z += db.vz * simDt;
      db.mesh.rotation.x += db.rx * simDt;
      db.mesh.rotation.y += db.ry * simDt;
      const gy = getTerrainHeight(db.mesh.position.x, db.mesh.position.z) + 0.22;
      if (db.mesh.position.y < gy) {
        db.mesh.position.y = gy;
        db.vy *= -0.35;
        db.vx *= 0.62;
        db.vz *= 0.62;
        db.rx *= 0.5;
        db.ry *= 0.5;
      }
    }
  }

  // ── I. Camera Follow + Smooth Real-Time Summed-Sine Trauma Shake ──
  player.trauma = Math.max(0, player.trauma - realDt * 1.45);
  const shake = player.trauma * player.trauma * player.shakeMult * 0.45;
  const shX = shake * Math.sin(realTime * 46);
  const shY = shake * Math.sin(realTime * 61);

  const playerGroundY = getTerrainHeight(player.x, player.z);
  if (menuOpen) {
    // Cinematic slow desert hero orbit behind the Command Launch Overlay!
    const ang = realTime * 0.22;
    const rad = 16.5;
    camera.position.set(player.x + Math.sin(ang) * rad, playerGroundY + 7.2, player.z + Math.cos(ang) * rad);
    camLook.set(player.x, playerGroundY + 2.6, player.z - 5);
    camera.lookAt(camLook);
  } else if (player.studioMode) {
    studioControls.update();
  } else {
    const dist = player.camZoom + (player.morph > 0.5 ? 2.4 : 0);
    const height = 4.4 + Math.sin(player.camPitch) * dist;
    const horiz = Math.cos(player.camPitch) * dist;
    camPosTarget.set(
      player.x + Math.sin(player.camYaw) * horiz,
      Math.max(getTerrainHeight(player.x + Math.sin(player.camYaw) * horiz, player.z + Math.cos(player.camYaw) * horiz) + 2.2, playerGroundY + height),
      player.z + Math.cos(player.camYaw) * horiz
    );
    camera.position.lerp(camPosTarget, 1 - Math.exp(-10 * realDt));
    camera.position.x += shX;
    camera.position.y += shY;

    // Look downrange past the mech so the hero sits cleanly in the lower-mid foreground
    camLook.set(
      player.x - Math.sin(player.camYaw) * 14,
      playerGroundY + 1.8 - Math.sin(player.camPitch - 0.35) * 10,
      player.z - Math.cos(player.camYaw) * 14
    );
    camera.lookAt(camLook);
  }

  // Dramatic low-angle side-raking desert sunlight for sweeping dune shadows!
  sun.target.position.set(player.x, playerGroundY, player.z - 14);
  sun.position.set(player.x - 62, playerGroundY + 23, player.z - 22);

  // ── J. Project 3D Enemy HP Bars & Golden Target Lock Brackets ──
  const wHalf = window.innerWidth * 0.5;
  const hHalf = window.innerHeight * 0.5;
  let lockedOnScreen = false;

  for (const e of enemies) {
    if (e.isBoss) {
      e.hpEl.style.display = "none";
      if (e.id === lockedEnemyId) {
        tmpV2.set(e.x, getTerrainHeight(e.x, e.z) + 4.4, e.z).project(camera);
        if (tmpV2.z <= 1) {
          lockedOnScreen = true;
          reticleEl.style.left = `${tmpV2.x * wHalf + wHalf}px`;
          reticleEl.style.top = `${-tmpV2.y * hHalf + hHalf}px`;
        }
      }
      continue;
    }
    tmpV1.set(e.x, getTerrainHeight(e.x, e.z) + (e.heavy ? 5.3 : 4.5), e.z).project(camera);
    if (tmpV1.z > 1) {
      e.hpEl.style.display = "none";
      continue;
    }
    const sx = tmpV1.x * wHalf + wHalf;
    const sy = -tmpV1.y * hHalf + hHalf;
    e.hpEl.style.display = "block";
    e.hpEl.style.left = `${sx}px`;
    e.hpEl.style.top = `${sy}px`;
    e.hpEl.classList.toggle("locked", e.id === lockedEnemyId);
    e.fillEl.style.width = `${Math.max(0, (e.hp / e.maxHp) * 100)}%`;

    if (e.id === lockedEnemyId) {
      tmpV2.set(e.x, getTerrainHeight(e.x, e.z) + 2.4, e.z).project(camera);
      if (tmpV2.z <= 1) {
        lockedOnScreen = true;
        reticleEl.style.left = `${tmpV2.x * wHalf + wHalf}px`;
        reticleEl.style.top = `${-tmpV2.y * hHalf + hHalf}px`;
      }
    }
  }

  // Project Story Mode 3D Objective Waypoints & Artillery Pylon HP Bars
  const projectWp = (el: HTMLDivElement, wx: number, wy: number, wz: number, baseLabel: string) => {
    const distM = Math.round(Math.hypot(wx - player.x, wz - player.z));
    tmpV1.set(wx, wy, wz).project(camera);
    let sx = tmpV1.x * wHalf + wHalf;
    let sy = -tmpV1.y * hHalf + hHalf;
    if (tmpV1.z > 1) {
      sx = sx < wHalf ? window.innerWidth - 46 : 46;
      sy = window.innerHeight - 96;
    }
    sx = THREE.MathUtils.clamp(sx, 48, window.innerWidth - 48);
    sy = THREE.MathUtils.clamp(sy, 76, window.innerHeight - 96);
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    const tag = el.firstElementChild;
    if (tag) tag.textContent = `${baseLabel} · ${distM}m`;
  };

  for (const mc of missionCores) {
    projectWp(mc.wpEl, mc.x, getTerrainHeight(mc.x, mc.z) + 3.2, mc.z, mc.label);
  }
  for (const rt of relayTowers) {
    const lbl = rt.captured ? rt.label : rt.progress > 0 ? `${rt.label} ${Math.round(rt.progress)}%` : rt.label;
    projectWp(rt.wpEl, rt.x, getTerrainHeight(rt.x, rt.z) + 11.2, rt.z, lbl);
  }
  if (convoy) {
    projectWp(convoy.wpEl, convoy.x, getTerrainHeight(convoy.x, convoy.z) + 5.2, convoy.z, "ATLAS-6");
  }
  for (const pyObj of artilleryPylons) {
    const pyTop = getTerrainHeight(pyObj.x, pyObj.z) + 10.6;
    projectWp(pyObj.wpEl, pyObj.x, pyTop, pyObj.z, pyObj.label);
    tmpV1.set(pyObj.x, pyTop - 1.2, pyObj.z).project(camera);
    if (tmpV1.z > 1) {
      pyObj.hpEl.style.display = "none";
    } else {
      pyObj.hpEl.style.display = "block";
      pyObj.hpEl.style.left = `${tmpV1.x * wHalf + wHalf}px`;
      pyObj.hpEl.style.top = `${-tmpV1.y * hHalf + hHalf}px`;
      pyObj.fillEl.style.width = `${Math.max(0, (pyObj.hp / pyObj.maxHp) * 100)}%`;
    }
  }

  reticleEl.classList.toggle("locked", lockedOnScreen);
  if (!lockedOnScreen) {
    reticleEl.style.left = "50%";
    reticleEl.style.top = "45%";
  }

  // ── K. Sync Minimalist DUNEFALL HUD Counters ──
  plateFillEl.style.width = `${(player.plate / player.maxPlate) * 100}%`;
  plateValEl.textContent = String(Math.round(player.plate));
  heatFillEl.style.width = `${player.heat}%`;
  heatValEl.textContent = `${Math.round(player.heat)}%`;
  cellsValEl.textContent = String(player.cells);
  for (let i = 0; i < cellsGridEl.children.length; i++) {
    cellsGridEl.children[i].classList.toggle("on", i < player.cells);
  }
  hullFillEl.style.width = `${Math.max(0, (player.hull / player.maxHull) * 100)}%`;
  hullValEl.textContent = `${Math.max(0, Math.round(player.hull))} / ${player.maxHull}`;
  shotsValEl.textContent = String(player.shots);
  tierNumEl.textContent = String(player.tier);
  coresValEl.textContent = `${player.cores} / ${player.coresNeeded}`;
  killsValEl.textContent = String(player.kills);
  scoreValEl.textContent = player.score.toLocaleString();

  squadSubEl.textContent = player.squadCd > 0 ? `Recharging · ${Math.ceil(player.squadCd)}s` : "2 drones + 3 cars ready";
  btnSquad.classList.toggle("cooling", player.squadCd > 0);
  podSubEl.textContent = player.podCd > 0 ? `Recharging · ${Math.ceil(player.podCd)}s` : "Ready · 20s deployment";
  btnPod.classList.toggle("cooling", player.podCd > 0);

  const upRailEl = document.getElementById("up-rail")!;
  const upPodsEl = document.getElementById("up-pods")!;
  const upPlateEl = document.getElementById("up-plate")!;
  for (let i = 0; i < 5; i++) {
    upRailEl.children[i].classList.toggle("on", i < player.upRail);
    upPodsEl.children[i].classList.toggle("on", i < player.upPods);
    upPlateEl.children[i].classList.toggle("on", i < player.upPlate);
  }

  // ── L. Render Frame (High PBR Bloom vs Eco Fast Pass) ──
  renderer.info.reset();
  if (ecoMode || !composer) {
    renderer.render(scene, camera);
  } else {
    composer.render();
  }
});

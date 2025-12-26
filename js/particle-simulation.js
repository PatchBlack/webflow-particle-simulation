// Three.js WebGPU Particle Simulation for Webflow
// GitHub: PatchBlack/webflow-particle-simulation

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { RenderTarget } from 'three';

import {
  Fn,
  If,
  Return,
  instancedArray,
  instanceIndex,
  uniform,
  attribute,
  positionWorld,
  uint,
  float,
  clamp,
  struct,
  atomicStore,
  int,
  ivec3,
  array,
  vec3,
  atomicAdd,
  Loop,
  atomicLoad,
  max,
  pow,
  mat3,
  vec4,
  cross,
  step,
  uv,
  vec2,
  texture,
} from 'three/tsl';

// Base CDN URL for assets
const ASSET_BASE_URL = 'https://cdn.jsdelivr.net/gh/PatchBalck/webflow-particle-simulation@main';

// Particle position data for morphing
let cubePositions, conePositions, monkeyPositions;
let globalMinX, globalMaxX, globalMinY, globalMaxY, globalMinZ, globalMaxZ, globalMaxRange;
let currentShapeIndex = 0; // 0=cube, 1=cone, 2=monkey

// 3D Models
let monitorModel, mobileModel, vrModel;
const modelLoader = new GLTFLoader();
let nextShapeIndex = 1;
let morphProgress = 0;
let autoMorphRotation = 0;
const morphDuration = 0.3;
const fullRotation = Math.PI * 2;

function deg(degrees) {
  return degrees * (Math.PI / 180);
}

// Load particle positions
async function loadParticlePositions() {
  const totalAssets = 7; // 3 particles + 3 models + 1 HDR
  let loadedAssets = 0;

  function updateProgress() {
    loadedAssets++;
    const progress = (loadedAssets / totalAssets) * 100;
    window.dispatchEvent(new CustomEvent('particleLoadProgress', { 
      detail: { progress, loaded: loadedAssets, total: totalAssets }
    }));
  }

  const [cubeData, coneData, monkeyData] = await Promise.all([
    fetch(`${ASSET_BASE_URL}/assets/particles/monitor-particle.json`)
      .then((r) => r.json())
      .then(data => { updateProgress(); return data; }),
    fetch(`${ASSET_BASE_URL}/assets/particles/phone-particle.json`)
      .then((r) => r.json())
      .then(data => { updateProgress(); return data; }),
    fetch(`${ASSET_BASE_URL}/assets/particles/vr-particle.json`)
      .then((r) => r.json())
      .then(data => { updateProgress(); return data; }),
  ]);

  cubePositions = cubeData;
  conePositions = coneData;
  monkeyPositions = monkeyData;
}

// Update morphing progress
function updateMorphing(deltaTime, rotationDelta) {
  autoMorphRotation += rotationDelta;

  if (autoMorphRotation >= fullRotation) {
    autoMorphRotation = 0;
    startMorph();
  }

  if (morphProgress < 1.0) {
    morphProgress += deltaTime / morphDuration;
    if (morphProgress >= 1.0) {
      morphProgress = 1.0;
      currentShapeIndex = nextShapeIndex;
    }
  }
}

function updateModels() {
  const containers = [window.monitorContainer, window.mobileContainer, window.vrContainer];
  
  containers.forEach(container => {
    if (container) {
      container.rotation.y = particleMesh.rotation.y + Math.PI;
    }
  });

  if (morphProgress < 1.0) {
    const currentContainer = containers[currentShapeIndex];
    const nextContainer = containers[nextShapeIndex];
    
    currentModelThresholdUniform.value = morphProgress;
    nextModelThresholdUniform.value = 1.0 - morphProgress;
    
    glitchIntensity.value = 1.0 - Math.abs(morphProgress - 0.5) * 2;
    
    if (currentContainer) currentContainer.visible = true;
    if (nextContainer) nextContainer.visible = true;
    
    const otherIndex = [0, 1, 2].find(i => i !== currentShapeIndex && i !== nextShapeIndex);
    if (containers[otherIndex]) {
      containers[otherIndex].visible = false;
    }
  } else {
    currentModelThresholdUniform.value = -1.0;
    nextModelThresholdUniform.value = 1.0;
    
    glitchIntensity.value = 0.0;
    
    containers.forEach((container, index) => {
      if (container) {
        container.visible = (index === currentShapeIndex);
      }
    });
  }
}

function startMorph() {
  morphProgress = 0;
  nextShapeIndex = (currentShapeIndex + 1) % 3;
}

function normalizePosition(pos) {
  return {
    x: 0.5 - ((pos[0] - (globalMinX + globalMaxX) / 2) / globalMaxRange) * 1,
    y: 0.5 + ((pos[2] - (globalMinZ + globalMaxZ) / 2) / globalMaxRange) * 1,
    z: 0.5 + ((pos[1] - (globalMinY + globalMaxY) / 2) / globalMaxRange) * 1,
  };
}

// Load 3D models
async function loadModels() {
  function updateProgress() {
    const event = new CustomEvent('particleLoadProgress', { 
      detail: { progress: 0, loaded: 0, total: 0 }
    });
    window.dispatchEvent(event);
  }

  const hdrLoader = new HDRLoader();
  const envMap = await hdrLoader.loadAsync(`${ASSET_BASE_URL}/assets/textures/royal_esplanade_1k.hdr`)
    .then(map => {
      updateProgress();
      return map;
    });
  envMap.mapping = THREE.EquirectangularReflectionMapping;

  const [monitorGltf, mobileGltf, vrGltf] = await Promise.all([
    modelLoader.loadAsync(`${ASSET_BASE_URL}/assets/models/monitor.glb`)
      .then(gltf => { updateProgress(); return gltf; }),
    modelLoader.loadAsync(`${ASSET_BASE_URL}/assets/models/mobile.glb`)
      .then(gltf => { updateProgress(); return gltf; }),
    modelLoader.loadAsync(`${ASSET_BASE_URL}/assets/models/vr-glass.glb`)
      .then(gltf => { updateProgress(); return gltf; }),
  ]);

  const monitorContainer = new THREE.Group();
  const mobileContainer = new THREE.Group();
  const vrContainer = new THREE.Group();

  monitorContainer.position.set(0.5, 0.5, 0.5);
  mobileContainer.position.set(0.5, 0.5, 0.5);
  vrContainer.position.set(0.5, 0.5, 0.5);

  monitorModel = monitorGltf.scene;
  mobileModel = mobileGltf.scene;
  vrModel = vrGltf.scene;

  monitorModel.position.set(0, 0, 0);
  mobileModel.position.set(0, 0, 0);
  vrModel.position.set(0, 0, 0);

  monitorModel.scale.setScalar(params.modelScale);
  mobileModel.scale.setScalar(params.modelScale);
  vrModel.scale.setScalar(params.modelScale);

  [monitorModel, mobileModel, vrModel].forEach((model, modelIndex) => {
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        
        if (child.material) {
          child.material.transparent = true;
          child.material.envMap = envMap;
          child.material.envMapIntensity = 1.0;
          
          const materialModelIndexUniform = uniform(modelIndex, 'int');
          
          child.material.opacityNode = Fn(() => {
            const worldY = positionWorld.y;
            const t = timeUniform;
            
            const scan1 = worldY.mul(80.0).add(t.mul(25.0)).sin();
            const scan2 = worldY.mul(120.0).add(t.mul(-40.0)).sin();
            const scan3 = worldY.mul(200.0).add(t.mul(60.0)).sin();
            const scan4 = worldY.mul(150.0).add(t.mul(-35.0)).sin();
            
            const jitter = worldY.mul(300.0).add(t.mul(100.0)).sin();
            
            const glitchPattern = scan1.mul(0.4)
              .add(scan2.mul(0.25))
              .add(scan3.mul(0.15))
              .add(scan4.mul(0.15))
              .add(jitter.mul(0.2));
            
            const threshold = float(2.0).toVar();
            
            If(materialModelIndexUniform.equal(currentShapeIndexUniform), () => {
              threshold.assign(currentModelThresholdUniform.mul(2.0).sub(1.0));
            })
            .ElseIf(materialModelIndexUniform.equal(nextShapeIndexUniform), () => {
              threshold.assign(nextModelThresholdUniform.mul(2.0).sub(1.0));
            });
            
            const bandVisible = step(threshold, glitchPattern);
            
            return bandVisible;
          })();
          
          child.material.needsUpdate = true;
        }
      }
    });
  });

  monitorContainer.add(monitorModel);
  mobileContainer.add(mobileModel);
  vrContainer.add(vrModel);

  monitorContainer.visible = true;
  mobileContainer.visible = false;
  vrContainer.visible = false;

  scene.add(monitorContainer);
  scene.add(mobileContainer);
  scene.add(vrContainer);

  window.monitorContainer = monitorContainer;
  window.mobileContainer = mobileContainer;
  window.vrContainer = vrContainer;

  [monitorContainer, mobileContainer, vrContainer].forEach(container => {
    container.layers.set(1);
    container.traverse((child) => {
      child.layers.set(1);
    });
  });
}

let renderer, scene, camera;

const clock = new THREE.Clock();

const maxParticles = 8192 * 16;
const gridSize1d = 64;
const gridSize = new THREE.Vector3(gridSize1d, gridSize1d, gridSize1d);
const fixedPointMultiplier = 1e7;

let particleCountUniform,
  stiffnessUniform,
  restDensityUniform,
  dynamicViscosityUniform,
  dtUniform,
  gravityUniform,
  gridSizeUniform,
  timeUniform,
  turbulenceStrengthUniform,
  turbulenceFreqUniform;
let particleBuffer, cellBuffer, cellBufferFloat;
let clearGridKernel, p2g1Kernel, p2g2Kernel, updateGridKernel, g2pKernel;
let particleMesh;
const mouseCoord = new THREE.Vector3();
const prevMouseCoord = new THREE.Vector3();
let mouseRayOriginUniform, mouseRayDirectionUniform, mouseForceUniform;
let vortexStrengthUniform, wave2StrengthUniform, wave3StrengthUniform;

if (WebGPU.isAvailable() === false) {
  document.body.appendChild(WebGPU.getErrorMessage());
  throw new Error("No WebGPU support");
}

const params = {
  particleCount: 60000,
  gravity: 0,
  turbulenceStrength: 1,
  turbulenceFreq: 40,
  wave2Strength: 35,
  wave3Strength: 20,
  vortexStrength: 8,
  wave2Freq: 0.75,
  viscosity: 0.5,
  fluidStrength: 1.0,
  modelScale: 0.4,
};

init();

async function init() {
  await loadParticlePositions();

  renderer = new THREE.WebGPURenderer({ 
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.00;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x000000, 0);
  
  // Find or create canvas container
  let container = document.getElementById('particle-canvas-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'particle-canvas-container';
    container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';
    document.body.appendChild(container);
  }
  container.appendChild(renderer.domElement);

  const renderTarget = new THREE.RenderTarget(
    window.innerWidth,
    window.innerHeight,
    { 
      samples: 4,
      alpha: true
    }
  );

  const postMaterial = new THREE.NodeMaterial();
  postMaterial.fragmentNode = Fn(() => {
    const screenUV = uv();
    const flippedUV = vec2(screenUV.x, float(1.0).sub(screenUV.y));
    const time = timeUniform;
    const intensity = glitchIntensity;
    const sceneTexture = texture(renderTarget.texture);
    
    const offsetR = vec2(
      intensity.mul(0.03).mul(time.mul(10.0).sin()),
      intensity.mul(0.015).mul(time.mul(13.0).cos())
    );
    const offsetG = vec2(0, 0);
    const offsetB = vec2(
      intensity.mul(-0.03).mul(time.mul(11.0).sin()),
      intensity.mul(-0.015).mul(time.mul(14.0).cos())
    );
    
    const r = sceneTexture.sample(flippedUV.add(offsetR)).r;
    const g = sceneTexture.sample(flippedUV.add(offsetG)).g;
    const b = sceneTexture.sample(flippedUV.add(offsetB)).b;
    const a = sceneTexture.sample(flippedUV).a;
    
    const scanline = flippedUV.y.mul(200.0).add(time.mul(50.0)).sin();
    const glitchOffset = scanline.mul(intensity).mul(0.05);
    
    return vec4(r, g, b, a);
  })();

  const postQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    postMaterial
  );
  postQuad.frustumCulled = false;

  const postScene = new THREE.Scene();
  postScene.add(postQuad);

  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  window.postProcessing = {
    renderTarget,
    postScene,
    postCamera
  };

  camera = new THREE.PerspectiveCamera(
    10,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
  );

  // Device-responsive camera positioning
  if (window.innerWidth < 480) {
    camera.position.set(0.5, 0.5, -9);
  } else if (window.innerWidth < 768) {
    camera.position.set(0.5, 0.5, -8);
  } else if (window.innerWidth < 1024) {
    camera.position.set(0.5, 0.5, -7);
  } else {
    camera.position.set(0.5, 0.5, -6);
  }

  camera.rotation.set(0, Math.PI, 0);
  camera.layers.enable(0);
  camera.layers.enable(1);

  scene = new THREE.Scene();
  // NO background color - transparent

  await loadModels();

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-10, 4, -4);
  light.target.position.set(0.5, 0.5, 0.5);
  scene.add(light.target);

  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 30;
  light.shadow.camera.left = -3;
  light.shadow.camera.right = 3;
  light.shadow.camera.top = 3;
  light.shadow.camera.bottom = -3;
  light.shadow.bias = -0.0001;

  scene.add(light);
  light.layers.set(0);

  const light2 = new THREE.DirectionalLight(0xffffff, 0.5);
  light2.position.set(0, 0, -2);
  light2.target.position.set(0.5, 0.5, 0.5);
  scene.add(light2.target);
  light2.castShadow = true;
  light2.shadow.mapSize.set(2048, 2048);
  light2.shadow.camera.near = 0.1;
  light2.shadow.camera.far = 30;
  light2.shadow.camera.left = -3;
  light2.shadow.camera.right = 3;
  light2.shadow.camera.top = 3;
  light2.shadow.camera.bottom = -3;
  light2.shadow.bias = -0.0001;
  scene.add(light2);
  light2.layers.set(0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambient);
  ambient.layers.set(0);

  const modelMainLight = new THREE.DirectionalLight(0xb0bbcb, 0.8);
  modelMainLight.position.set(-5, 3, -2);
  modelMainLight.target.position.set(0.5, 0.5, 0.5);
  scene.add(modelMainLight.target);
  modelMainLight.castShadow = true;
  modelMainLight.shadow.mapSize.set(1024, 1024);
  modelMainLight.shadow.camera.near = 0.1;
  modelMainLight.shadow.camera.far = 20;
  modelMainLight.shadow.camera.left = -2;
  modelMainLight.shadow.camera.right = 2;
  modelMainLight.shadow.camera.top = 2;
  modelMainLight.shadow.camera.bottom = -2;
  modelMainLight.layers.set(1);
  scene.add(modelMainLight);

  const modelFillLight = new THREE.DirectionalLight(0xb0bbcb, 0.3);
  modelFillLight.position.set(3, 1, 2);
  modelFillLight.layers.set(1);
  scene.add(modelFillLight);

  const modelAmbient = new THREE.AmbientLight(0xffffff, 0.4);
  modelAmbient.layers.set(1);
  scene.add(modelAmbient);

  setupParticles();

  window.addEventListener("resize", onWindowResize);

  renderer.setAnimationLoop(render);
  
  // Dispatch loading complete event
  window.dispatchEvent(new CustomEvent('particleLoadComplete'));
}

function setupBuffers() {
  const particleStruct = struct({
    position: { type: "vec3" },
    velocity: { type: "vec3" },
    C: { type: "mat3" },
    targetPosition: { type: "vec3" },
  });
  const particleStructSize = 18;
  const particleArray = new Float32Array(maxParticles * particleStructSize);

  const sourcePositions = cubePositions;
  const particlesToUse = Math.min(maxParticles, sourcePositions.length);

  globalMinX = Infinity;
  globalMinY = Infinity;
  globalMinZ = Infinity;
  globalMaxX = -Infinity;
  globalMaxY = -Infinity;
  globalMaxZ = -Infinity;

  [cubePositions, conePositions, monkeyPositions].forEach((shapePositions) => {
    for (let i = 0; i < Math.min(maxParticles, shapePositions.length); i++) {
      const pos = shapePositions[i];
      globalMinX = Math.min(globalMinX, pos[0]);
      globalMinY = Math.min(globalMinY, pos[1]);
      globalMinZ = Math.min(globalMinZ, pos[2]);
      globalMaxX = Math.max(globalMaxX, pos[0]);
      globalMaxY = Math.max(globalMaxY, pos[1]);
      globalMaxZ = Math.max(globalMaxZ, pos[2]);
    }
  });

  const rangeX = globalMaxX - globalMinX;
  const rangeY = globalMaxY - globalMinY;
  const rangeZ = globalMaxZ - globalMinZ;
  globalMaxRange = Math.max(rangeX, rangeY, rangeZ);

  for (let i = 0; i < particlesToUse; i++) {
    const pos = sourcePositions[i];

    const x = 0.5 - ((pos[0] - (globalMinX + globalMaxX) / 2) / globalMaxRange) * 1;
    const z = 0.5 + ((pos[1] - (globalMinY + globalMaxY) / 2) / globalMaxRange) * 1;
    const y = 0.5 + ((pos[2] - (globalMinZ + globalMaxZ) / 2) / globalMaxRange) * 1;

    particleArray[i * particleStructSize] = x;
    particleArray[i * particleStructSize + 1] = y;
    particleArray[i * particleStructSize + 2] = z;

    particleArray[i * particleStructSize + 15] = x;
    particleArray[i * particleStructSize + 16] = y;
    particleArray[i * particleStructSize + 17] = z;
  }

  particleBuffer = instancedArray(particleArray, particleStruct);

  const shapePositionStruct = struct({
    position: { type: "vec3" },
  });

  const cubePositionArray = new Float32Array(maxParticles * 3);
  const conePositionArray = new Float32Array(maxParticles * 3);
  const monkeyPositionArray = new Float32Array(maxParticles * 3);

  for (let i = 0; i < Math.min(maxParticles, cubePositions.length); i++) {
    const cubeNorm = normalizePosition(cubePositions[i]);
    const coneNorm = normalizePosition(conePositions[i]);
    const monkeyNorm = normalizePosition(monkeyPositions[i]);

    cubePositionArray[i * 3] = cubeNorm.x;
    cubePositionArray[i * 3 + 1] = cubeNorm.y;
    cubePositionArray[i * 3 + 2] = cubeNorm.z;

    conePositionArray[i * 3] = coneNorm.x;
    conePositionArray[i * 3 + 1] = coneNorm.y;
    conePositionArray[i * 3 + 2] = coneNorm.z;

    monkeyPositionArray[i * 3] = monkeyNorm.x;
    monkeyPositionArray[i * 3 + 1] = monkeyNorm.y;
    monkeyPositionArray[i * 3 + 2] = monkeyNorm.z;
  }

  window.cubeTargetBuffer = instancedArray(cubePositionArray, "vec3");
  window.coneTargetBuffer = instancedArray(conePositionArray, "vec3");
  window.monkeyTargetBuffer = instancedArray(monkeyPositionArray, "vec3");

  const cellCount = gridSize.x * gridSize.y * gridSize.z;

  const cellStruct = struct({
    x: { type: "int", atomic: true },
    y: { type: "int", atomic: true },
    z: { type: "int", atomic: true },
    mass: { type: "int", atomic: true },
  });

  cellBuffer = instancedArray(cellCount, cellStruct);
  cellBufferFloat = instancedArray(cellCount, "vec4");
}

function setupUniforms() {
  gridSizeUniform = uniform(gridSize);
  particleCountUniform = uniform(params.particleCount, "uint");
  stiffnessUniform = uniform(50);
  restDensityUniform = uniform(1.5);
  dynamicViscosityUniform = uniform(params.viscosity);
  dtUniform = uniform(1 / 60);
  gravityUniform = uniform(new THREE.Vector3(0, params.gravity, 0));
  mouseRayOriginUniform = uniform(new THREE.Vector3(0, 0, 0));
  mouseRayDirectionUniform = uniform(new THREE.Vector3(0, 0, 0));
  mouseForceUniform = uniform(new THREE.Vector3(0, 0, 0));
  timeUniform = uniform(0.0);
  turbulenceStrengthUniform = uniform(params.turbulenceStrength);
  turbulenceFreqUniform = uniform(params.turbulenceFreq);
  wave2StrengthUniform = uniform(params.wave2Strength);
  wave3StrengthUniform = uniform(params.wave3Strength);
  vortexStrengthUniform = uniform(params.vortexStrength);

  window.morphProgressUniform = uniform(0.0);
  window.currentShapeIndexUniform = uniform(0, "int");
  window.nextShapeIndexUniform = uniform(1, "int");
  window.wave2FreqUniform = uniform(params.wave2Freq);
  window.fluidStrengthUniform = uniform(params.fluidStrength);

  window.currentModelThresholdUniform = uniform(-1.0);
  window.nextModelThresholdUniform = uniform(-1.0);

  window.glitchIntensity = uniform(0.0);
}

function setupComputeShaders() {
  const encodeFixedPoint = (f32) => {
    return int(f32.mul(fixedPointMultiplier));
  };

  const decodeFixedPoint = (i32) => {
    return float(i32).div(fixedPointMultiplier);
  };

  const cellCount = gridSize.x * gridSize.y * gridSize.z;
  
  clearGridKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(uint(cellCount)), () => {
      Return();
    });

    atomicStore(cellBuffer.element(instanceIndex).get("x"), 0);
    atomicStore(cellBuffer.element(instanceIndex).get("y"), 0);
    atomicStore(cellBuffer.element(instanceIndex).get("z"), 0);
    atomicStore(cellBuffer.element(instanceIndex).get("mass"), 0);
  })()
    .compute(cellCount)
    .setName("clearGridKernel");

  p2g1Kernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => {
      Return();
    });
    
    const particlePosition = particleBuffer
      .element(instanceIndex)
      .get("position")
      .toConst("particlePosition");
    const particleVelocity = particleBuffer
      .element(instanceIndex)
      .get("velocity")
      .toConst("particleVelocity");
    const C = particleBuffer.element(instanceIndex).get("C").toConst("C");

    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
    const cellIndex = ivec3(gridPosition).sub(1).toConst("cellIndex");
    const cellDiff = gridPosition.fract().sub(0.5).toConst("cellDiff");
    const w0 = float(0.5)
      .mul(float(0.5).sub(cellDiff))
      .mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5)
      .mul(float(0.5).add(cellDiff))
      .mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst("weights");

    Loop({ start: 0, end: 3, type: "int", name: "gx", condition: "<" }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: "int", name: "gy", condition: "<" }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: "int", name: "gz", condition: "<" }, ({ gz }) => {
          const weight = weights
            .element(gx)
            .x.mul(weights.element(gy).y)
            .mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX)
            .add(0.5)
            .sub(gridPosition)
            .toConst("cellDist");
          const Q = C.mul(cellDist);

          const massContrib = weight;
          const velContrib = massContrib
            .mul(particleVelocity.add(Q))
            .toConst("velContrib");
          const cellPtr = cellX.x
            .mul(int(gridSize.y * gridSize.z))
            .add(cellX.y.mul(int(gridSize.z)))
            .add(cellX.z)
            .toConst();
          const cell = cellBuffer.element(cellPtr);

          atomicAdd(cell.get("x"), encodeFixedPoint(velContrib.x));
          atomicAdd(cell.get("y"), encodeFixedPoint(velContrib.y));
          atomicAdd(cell.get("z"), encodeFixedPoint(velContrib.z));
          atomicAdd(cell.get("mass"), encodeFixedPoint(massContrib));
        });
      });
    });
  })()
    .compute(params.particleCount)
    .setName("p2g1Kernel");

  p2g2Kernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => {
      Return();
    });
    
    const particlePosition = particleBuffer
      .element(instanceIndex)
      .get("position")
      .toConst("particlePosition");
    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();

    const cellIndex = ivec3(gridPosition).sub(1).toConst("cellIndex");
    const cellDiff = gridPosition.fract().sub(0.5).toConst("cellDiff");
    const w0 = float(0.5)
      .mul(float(0.5).sub(cellDiff))
      .mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5)
      .mul(float(0.5).add(cellDiff))
      .mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst("weights");

    const density = float(0).toVar("density");
    Loop({ start: 0, end: 3, type: "int", name: "gx", condition: "<" }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: "int", name: "gy", condition: "<" }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: "int", name: "gz", condition: "<" }, ({ gz }) => {
          const weight = weights
            .element(gx)
            .x.mul(weights.element(gy).y)
            .mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellPtr = cellX.x
            .mul(int(gridSize.y * gridSize.z))
            .add(cellX.y.mul(int(gridSize.z)))
            .add(cellX.z)
            .toConst();
          const cell = cellBuffer.element(cellPtr);
          const mass = decodeFixedPoint(atomicLoad(cell.get("mass")));
          density.addAssign(mass.mul(weight));
        });
      });
    });

    const volume = float(1).div(density);
    const pressure = float(0.0).toConst("pressure");
    const stress = mat3(
      pressure.negate(), 0, 0,
      0, pressure.negate(), 0,
      0, 0, pressure.negate()
    ).toVar("stress");
    const dudv = particleBuffer
      .element(instanceIndex)
      .get("C")
      .toConst("C");

    const strain = dudv.add(dudv.transpose());
    stress.addAssign(strain.mul(dynamicViscosityUniform));
    const eq16Term0 = volume.mul(-4).mul(stress).mul(dtUniform);

    Loop({ start: 0, end: 3, type: "int", name: "gx", condition: "<" }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: "int", name: "gy", condition: "<" }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: "int", name: "gz", condition: "<" }, ({ gz }) => {
          const weight = weights
            .element(gx)
            .x.mul(weights.element(gy).y)
            .mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX)
            .add(0.5)
            .sub(gridPosition)
            .toConst("cellDist");
          const momentum = eq16Term0
            .mul(weight)
            .mul(cellDist)
            .toConst("momentum");

          const cellPtr = cellX.x
            .mul(int(gridSize.y * gridSize.z))
            .add(cellX.y.mul(int(gridSize.z)))
            .add(cellX.z)
            .toConst();
          const cell = cellBuffer.element(cellPtr);
          atomicAdd(cell.get("x"), encodeFixedPoint(momentum.x));
          atomicAdd(cell.get("y"), encodeFixedPoint(momentum.y));
          atomicAdd(cell.get("z"), encodeFixedPoint(momentum.z));
        });
      });
    });
  })()
    .compute(params.particleCount)
    .setName("p2g2Kernel");

  updateGridKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(uint(cellCount)), () => {
      Return();
    });
    
    const cell = cellBuffer.element(instanceIndex);
    const mass = decodeFixedPoint(atomicLoad(cell.get("mass"))).toConst();
    If(mass.lessThanEqual(0), () => {
      Return();
    });

    const vx = decodeFixedPoint(atomicLoad(cell.get("x"))).div(mass).toVar();
    const vy = decodeFixedPoint(atomicLoad(cell.get("y"))).div(mass).toVar();
    const vz = decodeFixedPoint(atomicLoad(cell.get("z"))).div(mass).toVar();

    const x = int(instanceIndex).div(int(gridSize.z * gridSize.y));
    const y = int(instanceIndex).div(int(gridSize.z)).mod(int(gridSize.y));
    const z = int(instanceIndex).mod(int(gridSize.z));
    
    If(x.lessThan(int(1)).or(x.greaterThan(int(gridSize.x).sub(int(2)))), () => {
      vx.assign(0);
    });
    If(y.lessThan(int(1)).or(y.greaterThan(int(gridSize.y).sub(int(2)))), () => {
      vy.assign(0);
    });
    If(z.lessThan(int(1)).or(z.greaterThan(int(gridSize.z).sub(int(2)))), () => {
      vz.assign(0);
    });

    cellBufferFloat.element(instanceIndex).assign(vec4(vx, vy, vz, mass));
  })()
    .compute(cellCount)
    .setName("updateGridKernel");

  g2pKernel = Fn(() => {
    If(instanceIndex.greaterThanEqual(particleCountUniform), () => {
      Return();
    });

    const particlePosition = particleBuffer
      .element(instanceIndex)
      .get("position")
      .toVar("particlePosition");
    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
    const particleVelocity = vec3(0).toVar();

    const cellIndex = ivec3(gridPosition).sub(1).toConst("cellIndex");
    const cellDiff = gridPosition.fract().sub(0.5).toConst("cellDiff");

    const w0 = float(0.5)
      .mul(float(0.5).sub(cellDiff))
      .mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5)
      .mul(float(0.5).add(cellDiff))
      .mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst("weights");

    const B = mat3(0).toVar("B");
    Loop({ start: 0, end: 3, type: "int", name: "gx", condition: "<" }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: "int", name: "gy", condition: "<" }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: "int", name: "gz", condition: "<" }, ({ gz }) => {
          const weight = weights
            .element(gx)
            .x.mul(weights.element(gy).y)
            .mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX)
            .add(0.5)
            .sub(gridPosition)
            .toConst("cellDist");
          const cellPtr = cellX.x
            .mul(int(gridSize.y * gridSize.z))
            .add(cellX.y.mul(int(gridSize.z)))
            .add(cellX.z)
            .toConst();

          const weightedVelocity = cellBufferFloat
            .element(cellPtr)
            .xyz.mul(weight)
            .toConst("weightedVelocity");
          const term = mat3(
            weightedVelocity.mul(cellDist.x),
            weightedVelocity.mul(cellDist.y),
            weightedVelocity.mul(cellDist.z)
          );
          B.addAssign(term);
          particleVelocity.addAssign(weightedVelocity.mul(fluidStrengthUniform));
        });
      });
    });

    particleBuffer.element(instanceIndex).get("C").assign(B.mul(4).mul(fluidStrengthUniform));

    particleVelocity.addAssign(gravityUniform.mul(dtUniform));
    particleVelocity.divAssign(gridSizeUniform);

    const cubeTarget = window.cubeTargetBuffer.element(instanceIndex);
    const coneTarget = window.coneTargetBuffer.element(instanceIndex);
    const monkeyTarget = window.monkeyTargetBuffer.element(instanceIndex);

    const currentTarget = vec3(0).toVar();
    const nextTarget = vec3(0).toVar();

    If(currentShapeIndexUniform.equal(int(0)), () => {
      currentTarget.assign(cubeTarget);
    })
      .ElseIf(currentShapeIndexUniform.equal(int(1)), () => {
        currentTarget.assign(coneTarget);
      })
      .Else(() => {
        currentTarget.assign(monkeyTarget);
      });

    If(nextShapeIndexUniform.equal(int(0)), () => {
      nextTarget.assign(cubeTarget);
    })
      .ElseIf(nextShapeIndexUniform.equal(int(1)), () => {
        nextTarget.assign(coneTarget);
      })
      .Else(() => {
        nextTarget.assign(monkeyTarget);
      });

    const targetPos = currentTarget.add(
      nextTarget.sub(currentTarget).mul(morphProgressUniform)
    );

    const toTarget = targetPos.sub(particlePosition);
    const springStrength = float(200.0);
    const springForce = toTarget.mul(springStrength);
    particleVelocity.addAssign(springForce.mul(dtUniform));

    const damping = float(0.85);
    particleVelocity.mulAssign(damping);

    const pos = particlePosition.mul(turbulenceFreqUniform);
    const t = timeUniform;

    const wave1X = pos.y.add(t).sin().mul(pos.z.add(t.mul(1.3)).cos());
    const wave1Y = pos.z.add(t.mul(1.1)).sin().mul(pos.x.add(t.mul(0.9)).cos());
    const wave1Z = pos.x.add(t.mul(0.8)).sin().mul(pos.y.add(t.mul(1.2)).cos());
    const wave1 = vec3(wave1X, wave1Y, wave1Z).mul(turbulenceStrengthUniform);

    particleVelocity.addAssign(wave1.mul(dtUniform));

    const w = timeUniform;
    const pos2 = particlePosition.mul(wave2FreqUniform).add(vec3(0, w.mul(0.5), 0));

    const noiseScale = float(10.0);
    const n1 = pos2.x
      .mul(noiseScale)
      .sin()
      .mul(pos2.y.mul(noiseScale.mul(1.1)).cos())
      .mul(pos2.z.mul(noiseScale.mul(0.9)).sin());
    const n2 = pos2.y
      .mul(noiseScale.mul(1.2))
      .sin()
      .mul(pos2.z.mul(noiseScale.mul(0.8)).cos())
      .mul(pos2.x.mul(noiseScale.mul(1.3)).sin());
    const n3 = pos2.z
      .mul(noiseScale.mul(0.95))
      .sin()
      .mul(pos2.x.mul(noiseScale.mul(1.15)).cos())
      .mul(pos2.y.mul(noiseScale.mul(1.05)).sin());

    const curlX = n3.sub(n2);
    const curlY = n1.sub(n3).add(0.3);
    const curlZ = n2.sub(n1);

    const smokeFlow = vec3(curlX, curlY, curlZ)
      .normalize()
      .mul(wave2StrengthUniform);

    const morphTurbulence = float(1.0).sub(morphProgressUniform);
    particleVelocity.addAssign(smokeFlow.mul(dtUniform).mul(morphTurbulence));

    const dist = cross(
      mouseRayDirectionUniform,
      particlePosition.sub(mouseRayOriginUniform)
    ).length();
    const force = dist.mul(4.0).oneMinus().max(0.0).pow(3);
    particleVelocity.addAssign(mouseForceUniform.mul(force));

    particlePosition.addAssign(particleVelocity.mul(dtUniform));

    particlePosition.assign(
      clamp(
        particlePosition,
        vec3(0.5).div(gridSizeUniform),
        vec3(gridSize).sub(1).div(gridSizeUniform)
      )
    );

    particleVelocity.mulAssign(gridSizeUniform);

    particleBuffer.element(instanceIndex).get("position").assign(particlePosition);
    particleBuffer.element(instanceIndex).get("velocity").assign(particleVelocity);
  })()
    .compute(params.particleCount)
    .setName("g2pKernel");
}

function setupMesh() {
  const geometry = BufferGeometryUtils.mergeVertices(
    new THREE.IcosahedronGeometry(0.0035, 1).deleteAttribute("uv")
  );

  const material = new THREE.MeshStandardNodeMaterial({
    color: "#a0aec1",
    roughness: 1.0,
    metalness: 0.0
  });

  material.positionNode = Fn(() => {
    const particlePosition = particleBuffer
      .element(instanceIndex)
      .get("position");
    const offset = vec3(-0.5, -0.5, -0.5);
    return attribute("position").add(particlePosition).add(offset);
  })();

  material.colorNode = Fn(() => {
    const particlePosition = particleBuffer
      .element(instanceIndex)
      .get("position");

    const cubeTarget = window.cubeTargetBuffer.element(instanceIndex);
    const coneTarget = window.coneTargetBuffer.element(instanceIndex);
    const monkeyTarget = window.monkeyTargetBuffer.element(instanceIndex);

    const currentTarget = vec3(0).toVar();
    const nextTarget = vec3(0).toVar();

    If(currentShapeIndexUniform.equal(int(0)), () => {
      currentTarget.assign(cubeTarget);
    })
      .ElseIf(currentShapeIndexUniform.equal(int(1)), () => {
        currentTarget.assign(coneTarget);
      })
      .Else(() => {
        currentTarget.assign(monkeyTarget);
      });

    If(nextShapeIndexUniform.equal(int(0)), () => {
      nextTarget.assign(cubeTarget);
    })
      .ElseIf(nextShapeIndexUniform.equal(int(1)), () => {
        nextTarget.assign(coneTarget);
      })
      .Else(() => {
        nextTarget.assign(monkeyTarget);
      });

    const targetPos = currentTarget.add(
      nextTarget.sub(currentTarget).mul(morphProgressUniform)
    );

    const distanceFromTarget = particlePosition.sub(targetPos).length();
    const distanceThreshold = float(0.2);

    const inPlaceColor = vec3(0.627, 0.682, 0.757);
    const awayColor = vec3(1.0, 0.831, 0.255);

    const isMorphing = morphProgressUniform.lessThan(float(1.0));
    const isAway = distanceFromTarget.greaterThan(distanceThreshold);

    const finalColorWhenSettled = isAway.select(awayColor, inPlaceColor);
    const finalColor = isMorphing.select(inPlaceColor, finalColorWhenSettled);

    const gamma = float(2.2);
    const linearColor = vec3(
      pow(finalColor.x, gamma),
      pow(finalColor.y, gamma),
      pow(finalColor.z, gamma)
    );

    return linearColor;
  })();

  particleMesh = new THREE.Mesh(geometry, material);
  particleMesh.count = params.particleCount;
  particleMesh.position.set(0.5, 0.5, 0.5);
  particleMesh.frustumCulled = false;
  particleMesh.castShadow = true;
  particleMesh.receiveShadow = true;
  scene.add(particleMesh);
}

function setupMouse() {
  const raycaster = new THREE.Raycaster();
  const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  const onMove = (event) => {
    const pointer = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );

    raycaster.setFromCamera(pointer, camera);

    const intersectPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(raycastPlane, intersectPoint);

    const center = new THREE.Vector3(0.5, 0.5, 0.5);
    const rotationAngle = -particleMesh.rotation.y;
    const rotationAxis = new THREE.Vector3(0, 1, 0);

    intersectPoint.sub(center);
    intersectPoint.applyAxisAngle(rotationAxis, rotationAngle);
    intersectPoint.add(center);
    mouseCoord.copy(intersectPoint);

    const rayOrigin = raycaster.ray.origin.clone();
    rayOrigin.sub(center);
    rayOrigin.applyAxisAngle(rotationAxis, rotationAngle);
    rayOrigin.add(center);
    mouseRayOriginUniform.value.copy(rayOrigin);

    const rayDirection = raycaster.ray.direction.clone();
    rayDirection.applyAxisAngle(rotationAxis, rotationAngle);
    mouseRayDirectionUniform.value.copy(rayDirection);
  };

  renderer.domElement.addEventListener("pointermove", onMove);
}

function setupParticles() {
  setupBuffers();
  setupUniforms();
  setupComputeShaders();
  setupMesh();
  setupMouse();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  window.postProcessing.renderTarget.setSize(window.innerWidth, window.innerHeight);
}

async function render() {
  const deltaTime = THREE.MathUtils.clamp(clock.getDelta(), 0.00001, 1 / 60);
  dtUniform.value = deltaTime;
  timeUniform.value = clock.getElapsedTime();

  const rotationThisFrame = deltaTime * 1;
  particleMesh.rotation.y += rotationThisFrame;

  updateMorphing(deltaTime, rotationThisFrame);

  morphProgressUniform.value = morphProgress;
  currentShapeIndexUniform.value = currentShapeIndex;
  nextShapeIndexUniform.value = nextShapeIndex;

  updateModels();

  mouseForceUniform.value
    .copy(mouseCoord)
    .sub(prevMouseCoord)
    .multiplyScalar(10);
  const mouseForceLength = mouseForceUniform.value.length();
  if (mouseForceLength > 0.3) {
    mouseForceUniform.value.multiplyScalar(10.0 / mouseForceLength);
  }
  prevMouseCoord.copy(mouseCoord);

  renderer.compute(clearGridKernel);
  renderer.compute(p2g1Kernel);
  renderer.compute(p2g2Kernel);
  renderer.compute(updateGridKernel);
  renderer.compute(g2pKernel);

  if (glitchIntensity.value > 0) {
    renderer.setRenderTarget(window.postProcessing.renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(window.postProcessing.postScene, window.postProcessing.postCamera);
  } else {
    renderer.render(scene, camera);
  }
}

const logElem = document.getElementById('log-text');
const toggleBtn = document.getElementById('toggle-btn');
const modeBtn = document.getElementById('mode-btn');
const videoElement = document.getElementById('webcam');

// ★ フラグ管理
let isRotating = true;
let currentMode = 'A'; // 'A': FishTank視差 (Off-Axis), 'B': 固定視体積

toggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  isRotating = !isRotating;
  toggleBtn.innerText = `回転: ${isRotating ? 'ON' : 'OFF'}`;
});

modeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  currentMode = (currentMode === 'A') ? 'B' : 'A';
  
  if (currentMode === 'A') {
    modeBtn.innerText = "現在のモード: モードA (FishTank視差)";
    modeBtn.style.background = "#6bffb8";
  } else {
    modeBtn.innerText = "現在のモード: モードB (固定視体積)";
    modeBtn.style.background = "#ffb86b";
    
    camera.position.set(0, 0, baseCameraZ);
    camera.rotation.set(0, 0, 0);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
});

// 1. Scene & Renderer Setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

const baseCameraZ = 5.0;
camera.position.set(0, 0, baseCameraZ);

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('stage'), antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// ライティング
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(2, 4, 3);
scene.add(dirLight);

// 2. Load Textures
const textureLoader = new THREE.TextureLoader();
const roomMaterials = [
  new THREE.MeshBasicMaterial({ map: textureLoader.load('右壁２.jpg'), side: THREE.BackSide }),
  new THREE.MeshBasicMaterial({ map: textureLoader.load('左壁２.jpg'), side: THREE.BackSide }),
  new THREE.MeshBasicMaterial({ map: textureLoader.load('天井壁.jpg'), side: THREE.BackSide }),
  new THREE.MeshBasicMaterial({ map: textureLoader.load('床.jpg'), side: THREE.BackSide }),
  new THREE.MeshBasicMaterial({ map: textureLoader.load('奥壁２.jpg'), side: THREE.BackSide }),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide })
];

let room;
let cubeMesh;
let screenWidth = 0;
let screenHeight = 0;
const depthRatio = 0.35;

// 3. 部屋と内部キューブの生成
function createSceneObjects() {
  const fovRad = (camera.fov * Math.PI) / 180;
  const aspect = window.innerWidth / window.innerHeight;

  screenHeight = 2 * Math.tan(fovRad / 2) * baseCameraZ;
  screenWidth = screenHeight * aspect;
  const roomDepth = screenHeight * depthRatio;

  if (room) scene.remove(room);
  if (cubeMesh) scene.remove(cubeMesh);

  // ① 部屋（背景）
  const roomGeo = new THREE.BoxGeometry(screenWidth, screenHeight, roomDepth);
  room = new THREE.Mesh(roomGeo, roomMaterials);
  room.position.set(0, 0, -roomDepth / 2);
  scene.add(room);

  // ② 正方形キューブ
  const cubeSize = Math.min(screenWidth, screenHeight) * 0.35;
  const cubeGeo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
  
  const cubeMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x44aa88, 
    roughness: 0.4,
    metalness: 0.2
  });
  
  cubeMesh = new THREE.Mesh(cubeGeo, cubeMaterial);
  cubeMesh.position.set(0, -screenHeight * 0.1, -roomDepth * 0.5);
  cubeMesh.rotation.y = Math.PI / 6; 
  scene.add(cubeMesh);
}

createSceneObjects();

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  createSceneObjects();
  
  if (currentMode === 'B') {
    camera.updateProjectionMatrix();
  }
});

// 4. テクスチャ動的変更（ファイル選択）処理
function setupTextureUploader(inputId, materialIndex) {
  const fileInput = document.getElementById(inputId);
  if (!fileInput) return;
  
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const imageUrl = URL.createObjectURL(file);

    textureLoader.load(imageUrl, (newTexture) => {
      if (roomMaterials[materialIndex].map) {
        roomMaterials[materialIndex].map.dispose();
      }
      roomMaterials[materialIndex].map = newTexture;
      roomMaterials[materialIndex].needsUpdate = true;
      logElem.innerText = `壁紙を更新しました`;
    });
  });
}

// 各入力フォームとマテリアルインデックスの紐付け
setupTextureUploader('input-right', 0); // 右壁
setupTextureUploader('input-left', 1);  // 左壁
setupTextureUploader('input-top', 2);   // 天井
setupTextureUploader('input-bottom', 3);// 床
setupTextureUploader('input-back', 4);  // 奥壁

// 5. FishTank Off-Axis Projection (覗き込み処理)
function setOffAxisProjection(camX, camY, camZ) {
  camera.position.set(camX, camY, camZ);
  camera.rotation.set(0, 0, 0);

  const left   = -screenWidth / 2 - camX;
  const right  =  screenWidth / 2 - camX;
  const top    =  screenHeight / 2 - camY;
  const bottom = -screenHeight / 2 - camY;

  const near = camera.near;
  const far  = camera.far;

  const scale = near / camZ;
  const l = left * scale;
  const r = right * scale;
  const t = top * scale;
  const b = bottom * scale;

  camera.projectionMatrix.makePerspective(l, r, t, b, near, far);
}

// 6. Face Tracking & Processing
let currentX = 0, currentY = 0, currentZ = baseCameraZ;
let targetX = 0, targetY = 0, targetZ = baseCameraZ;

const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });
faceMesh.onResults((results) => {
  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];
    const nose = landmarks[1];

    const trackingGain = 1.8; 
    targetX = -(nose.x - 0.5) * trackingGain * (screenWidth / 2); 
    targetY = -(nose.y - 0.5) * trackingGain * (screenHeight / 2); 
    targetZ = baseCameraZ;

    logElem.innerText = `FishTank 追従中 | X: ${targetX.toFixed(2)}, Y: ${targetY.toFixed(2)}`;
  }
});

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { width: 640, height: 480, facingMode: "user" } 
    });
    videoElement.srcObject = stream;
    videoElement.onloadedmetadata = () => {
      videoElement.play();
      processVideo();
    };
  } catch (e) {
    logElem.innerText = "カメラエラー: " + e.message;
  }
}

async function processVideo() {
  if (videoElement.readyState >= 2) {
    await faceMesh.send({ image: videoElement });
  }
  requestAnimationFrame(processVideo);
}

// 7. メイン描画ループ
function render() {
  currentX += (targetX - currentX) * 0.12;
  currentY += (targetY - currentY) * 0.12;
  currentZ += (targetZ - currentZ) * 0.12;

  if (currentMode === 'A') {
    setOffAxisProjection(currentX, currentY, currentZ);
  } else {
    camera.position.set(0, 0, baseCameraZ);
  }

  if (cubeMesh && isRotating) {
    cubeMesh.rotation.y += 0.01;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

// 起動
render();
initCamera();
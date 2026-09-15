(function () {
  // 1. MediaPipe FaceMesh ライブラリの動的インポート
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // 2. 視点回転（Axis-Angle）に応じたベクトル回転計算
  function rotateVectorByAxisAngle(vx, vy, vz, ax, ay, az, angle) {
    const len = Math.hypot(ax, ay, az);
    if (len === 0 || angle === 0) return { x: vx, y: vy, z: vz };
    ax /= len; ay /= len; az /= len;

    const halfAngle = angle / 2;
    const sinHalf = Math.sin(halfAngle);
    const qw = Math.cos(halfAngle);
    const qx = ax * sinHalf;
    const qy = ay * sinHalf;
    const qz = az * sinHalf;

    const ix =  qw * vx + qy * vz - qz * vy;
    const iy =  qw * vy + qz * vx - qx * vz;
    const iz =  qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;

    return {
      x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: iz * qw + iw * -qz + ix * -qy - iy * -qx
    };
  }

  // 3. X3DOMの投影行列（Projection Matrix）を拡張（Off-Axis射影の注入）
  function patchX3DOMProjection() {
    if (typeof x3dom !== 'undefined' && x3dom.nodeTypes && x3dom.nodeTypes.Viewpoint) {
      if (!window.ftvrPatched) {
        const origGetProj = x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix = function(aspect) {
          // 元の対称透視投影行列を取得
          const mat = origGetProj.call(this, aspect);
          
          if (window.ftvrOffset) {
            const fov = this._vf.fieldOfView || 0.785398;
            const baseD = window.ftvrBaseDist || 10.0;
            
            // 近平面での仮想スクリーンサイズを計算
            const screenH = 2.0 * baseD * Math.tan(fov / 2.0);
            const screenW = screenH * aspect;
            
            // ★核心部：投影行列のX, Yシアー成分を書き換えて非対称（Off-Axis）にする
            // カメラが右に動いた分、視野枠を左に補正して画面境界を固定する
            mat._02 = -(2.0 * window.ftvrOffset.x) / screenW;
            mat._12 = -(2.0 * window.ftvrOffset.y) / screenH;
          }
          return mat;
        };
        window.ftvrPatched = true;
      }
    }
  }

  // 4. システムメイン処理
  async function initFishTankVR() {
    if (!window.FaceMesh) {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js');
    }

    patchX3DOMProjection();

    // カメラ用隠しvideo要素の生成
    const videoElement = document.createElement('video');
    videoElement.id = 'ftvr-webcam';
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.style.display = 'none';
    document.body.appendChild(videoElement);

    // CSS不要のインラインスタイルUI生成
    const uiElement = document.createElement('div');
    uiElement.id = 'ftvr-ui';
    uiElement.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #6bffb8;
      padding: 6px 12px;
      border-radius: 6px;
      font-family: sans-serif;
      font-size: 0.75rem;
      z-index: 9999;
      pointer-events: none;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
    `;
    uiElement.innerHTML = '<span id="ftvr-status">FishTank VR 初期化中...</span>';
    document.body.appendChild(uiElement);

    const statusElem = document.getElementById('ftvr-status');

    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;

    // MediaPipe FaceMesh 設定
    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });

    faceMesh.onResults((results) => {
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const nose = results.multiFaceLandmarks[0][1];
        const trackingGain = 5.0; // 少し強めに設定（必要に応じて調整）
        targetX = -(nose.x - 0.5) * trackingGain;
        targetY = -(nose.y - 0.5) * trackingGain;
        statusElem.innerText = `FishTank VR 追従中`;
      }
    });

    // Webカメラ起動
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoElement.srcObject = stream;
      videoElement.play();

      async function processVideo() {
        if (videoElement.readyState >= 2) {
          await faceMesh.send({ image: videoElement });
        }
        requestAnimationFrame(processVideo);
      }
      processVideo();
    } catch (e) {
      statusElem.innerText = 'カメラエラー: ' + e.message;
      return;
    }

    // 5. デフォルト視点の指定（pingu_view -> front_view -> 最初のviewpoint）
    const defaultVp = document.getElementById('pingu_view') || 
                      document.getElementById('front_view') || 
                      document.querySelector('viewpoint');
    if (!defaultVp) return;

    // デフォルト初期座標・姿勢の取得と完全固定化
    const posAttr = (defaultVp.getAttribute('position') || "0 0 10").trim().split(/\s+/).map(Number);
    const oriAttr = (defaultVp.getAttribute('orientation') || "0 1 0 0").trim().split(/\s+/).map(Number);

    const defaultPos = { x: posAttr[0], y: posAttr[1], z: posAttr[2] };
    const defaultOri = { ax: oriAttr[0], ay: oriAttr[1], az: oriAttr[2], angle: oriAttr[3] };

    // 画面までの基準距離をデフォルト座標の原点からの距離として算出
    const baseDist = Math.hypot(defaultPos.x, defaultPos.y, defaultPos.z);
    window.ftvrBaseDist = baseDist === 0 ? 10.0 : baseDist;

    // 6. 追従描画ループ
    function renderLoop() {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;

      // オフセット量をグローバル変数に渡し、パッチ済みの投影行列に反映させる
      window.ftvrOffset = { x: currentX, y: currentY };

      // デフォルト初期回転を考慮して顔オフセットを回転変換
      const rotatedOffset = rotateVectorByAxisAngle(
        currentX, currentY, 0,
        defaultOri.ax, defaultOri.ay, defaultOri.az, defaultOri.angle
      );

      // デフォルト初期位置基準で座標を動的更新（カメラ自体の位置移動）
      const newX = defaultPos.x + rotatedOffset.x;
      const newY = defaultPos.y + rotatedOffset.y;
      const newZ = defaultPos.z + rotatedOffset.z;

      defaultVp.setAttribute('position', `${newX.toFixed(4)} ${newY.toFixed(4)} ${newZ.toFixed(4)}`);

      requestAnimationFrame(renderLoop);
    }

    renderLoop();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initFishTankVR, 1000);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(initFishTankVR, 1000));
  }
})();
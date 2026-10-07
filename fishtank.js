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

  // 2. X3DOMの行列計算パイプライン拡張（厳密なOff-Axis透視射影）
  function patchX3DOMPipeline() {
    if (typeof x3dom !== 'undefined' && x3dom.nodeTypes && x3dom.nodeTypes.Viewpoint) {
      if (!window.ftvrPatched) {

        // A. ビュー行列（View Matrix）の拡張：カメラ位置を目（Px, Py, Pz）に配置
        const origGetView = x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix = function() {
          const mat = origGetView.call(this);
          if (window.ftvrPos) {
            const Px = window.ftvrPos.x || 0;
            const Py = window.ftvrPos.y || 0;
            const Pz = window.ftvrPos.z || 0.35;

            if (x3dom.fields && x3dom.fields.SFMatrix4f && x3dom.fields.SFMatrix4f.translation) {
              // 画面中心(0,0,0)に対する視点のオフセット位置へ平行移動
              const trans = x3dom.fields.SFMatrix4f.translation(
                new x3dom.fields.SFVec3f(-Px, -Py, -(Pz - 0.35))
              );
              return trans.mult(mat);
            } else {
              mat._03 -= Px;
              mat._13 -= Py;
              mat._23 -= (Pz - 0.35);
            }
          }
          return mat;
        };

        // B. 投影行列（Projection Matrix）の拡張：完全な Off-Axis Frustum の計算
        const origGetProj = x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix = function(aspect) {
          if (window.ftvrPos) {
            const Px = window.ftvrPos.x || 0;
            const Py = window.ftvrPos.y || 0;
            const Pz = Math.max(window.ftvrPos.z || 0.35, 0.05); // 0除算防止

            // 6.1インチ画面の物理サイズ (m)
            const isLandscape = window.innerWidth > window.innerHeight;
            const W = isLandscape ? 0.147 : 0.068;
            const H = isLandscape ? 0.068 : 0.147;

            const near = 0.01;
            const far = 100.0;

            // 視点(Px, Py, Pz)から画面枠までの近平面上における開口領域(L, R, B, T)を算出
            const L = ((-W / 2.0) - Px) * (near / Pz);
            const R = ((W / 2.0) - Px) * (near / Pz);
            const B = ((-H / 2.0) - Py) * (near / Pz);
            const T = ((H / 2.0) - Py) * (near / Pz);

            // Off-Axis 透視投影行列の生成
            const mat = new x3dom.fields.SFMatrix4f();
            mat._00 = (2.0 * near) / (R - L);
            mat._01 = 0;
            mat._02 = (R + L) / (R - L);
            mat._03 = 0;

            mat._10 = 0;
            mat._11 = (2.0 * near) / (T - B);
            mat._12 = (T + B) / (T - B);
            mat._13 = 0;

            mat._20 = 0;
            mat._21 = 0;
            mat._22 = -(far + near) / (far - near);
            mat._23 = -(2.0 * far * near) / (far - near);

            mat._30 = 0;
            mat._31 = 0;
            mat._32 = -1.0;
            mat._33 = 0;

            return mat;
          }
          return origGetProj.call(this, aspect);
        };

        window.ftvrPatched = true;
      }
    }
  }

  // 3. システムメイン処理
  async function initFishTankVR() {
    if (!window.FaceMesh) {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js');
    }

    patchX3DOMPipeline();

    // カメラ用隠しvideo要素の生成
    const videoElement = document.createElement('video');
    videoElement.id = 'ftvr-webcam';
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.style.display = 'none';
    document.body.appendChild(videoElement);

    // 視点追従 ON/OFF 状態フラグ
    let isTrackingEnabled = true;

    // リアルタイム推定距離(m)の保持用変数
    let currentDistanceMeters = 0.35;

    // UIボタンの生成
    const uiElement = document.createElement('div');
    uiElement.id = 'ftvr-ui';
    uiElement.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.85);
      color: #6bffb8;
      padding: 8px 14px;
      border-radius: 8px;
      font-family: sans-serif;
      font-size: 0.8rem;
      font-weight: bold;
      z-index: 9999;
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      box-shadow: 0 3px 8px rgba(0,0,0,0.4);
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
    `;
    uiElement.innerHTML = '<span id="ftvr-status">FishTank VR 初期化中...</span>';
    document.body.appendChild(uiElement);

    const statusElem = document.getElementById('ftvr-status');

    function updateUI() {
      const distStr = currentDistanceMeters > 0 ? `${currentDistanceMeters.toFixed(2)} m` : '-- m';

      if (!isTrackingEnabled) {
        uiElement.style.background = 'rgba(60, 60, 60, 0.85)';
        uiElement.style.color = '#ccc';
        statusElem.innerHTML = `
          <div>📷 視点追従: <b style="color:#ff6b6b;">OFF</b> (クリックでON)</div>
          <div style="font-size:0.75rem; color:#aaa;">距離: ${distStr}</div>
        `;
      } else {
        uiElement.style.background = 'rgba(0, 0, 0, 0.85)';
        uiElement.style.color = '#6bffb8';
        statusElem.innerHTML = `
          <div>📷 視点追従: <b style="color:#6bffb8;">ON</b> (クリックでOFF)</div>
          <div style="font-size:0.75rem; color:#6bffb8;">デバイスまでの距離: <b>${distStr}</b></div>
        `;
      }
    }

    const toggleTracking = (e) => {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      isTrackingEnabled = !isTrackingEnabled;
      updateUI();
    };

    uiElement.addEventListener('pointerdown', toggleTracking);

    let targetPx = 0, targetPy = 0, targetPz = 0.35;
    let currentPx = 0, currentPy = 0, currentPz = 0.35;

    // MediaPipe FaceMesh 設定
    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });

    faceMesh.onResults((results) => {
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        const nose = landmarks[1];

        const leftEye = landmarks[468] || landmarks[33];
        const rightEye = landmarks[473] || landmarks[263];

        const vw = videoElement.videoWidth || 640;
        const vh = videoElement.videoHeight || 480;

        // 解像度補正付き両眼ピクセル距離
        const normDx = rightEye.x - leftEye.x;
        const normDy = (rightEye.y - leftEye.y) * (vh / vw);
        const distPx = Math.hypot(normDx, normDy) * vw;

        if (distPx > 0) {
          const realIPD = 0.063; // 6.3cm
          const focalLength = vw * 0.85;
          const calculatedDistance = (realIPD * focalLength) / distPx;

          currentDistanceMeters = currentDistanceMeters === 0
            ? calculatedDistance
            : currentDistanceMeters * 0.85 + calculatedDistance * 0.15;
        }

        if (isTrackingEnabled) {
          // Webカメラ画像上の位置(0~1)をメートル単位の物理座標(Px, Py, Pz)へ直結変換
          const Pz = Math.max(currentDistanceMeters, 0.10);
          
          // カメラ画角(約60度)から画面面における顔の物理X,Y位置(m)を算出
          const camFovRad = 1.047; // 60 deg
          const visibleW = 2.0 * Pz * Math.tan(camFovRad / 2.0);
          const visibleH = visibleW * (vh / vw);

          targetPx = -(nose.x - 0.5) * visibleW;
          targetPy = -(nose.y - 0.5) * visibleH;
          targetPz = Pz;
        } else {
          targetPx = 0;
          targetPy = 0;
          targetPz = 0.35;
        }

        updateUI();
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

    // 4. フレーム補間描画ループ
    function renderLoop() {
      currentPx += (targetPx - currentPx) * 0.15;
      currentPy += (targetPy - currentPy) * 0.15;
      currentPz += (targetPz - currentPz) * 0.15;

      // 算出された視点の絶対3次元位置 (m) パイプラインへ共有
      window.ftvrPos = { x: currentPx, y: currentPy, z: currentPz };

      const x3dElem = document.querySelector('x3d');
      if (x3dElem && x3dElem.runtime && x3dElem.runtime.triggerRedraw) {
        x3dElem.runtime.triggerRedraw();
      }

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
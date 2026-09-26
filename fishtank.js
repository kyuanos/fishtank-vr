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

  // 2. X3DOMの行列計算パイプライン拡張（Off-Axis射影 ＆ Z軸距離同期）
  function patchX3DOMPipeline() {
    if (typeof x3dom !== 'undefined' && x3dom.nodeTypes && x3dom.nodeTypes.Viewpoint) {
      if (!window.ftvrPatched) {

        // A. ビュー行列（View Matrix）の拡張
        // X, Y の左右上下の顔移動に加え、Z（距離の変化）も ViewMatrix のカメラ座標へ反映させる
        const origGetView = x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix = function() {
          const mat = origGetView.call(this);
          if (window.ftvrOffset) {
            const offsetX = window.ftvrOffset.x || 0;
            const offsetY = window.ftvrOffset.y || 0;
            const offsetZ = window.ftvrOffset.z || 0; // ★Z軸（距離差分）を追加

            if (offsetX !== 0 || offsetY !== 0 || offsetZ !== 0) {
              if (x3dom.fields && x3dom.fields.SFMatrix4f && x3dom.fields.SFMatrix4f.translation) {
                // カメラの位置を X, Y, Z すべて顔の変位に合わせて並進移動
                const trans = x3dom.fields.SFMatrix4f.translation(
                  new x3dom.fields.SFVec3f(-offsetX, -offsetY, -offsetZ)
                );
                return trans.mult(mat);
              } else {
                mat._03 -= offsetX;
                mat._13 -= offsetY;
                mat._23 -= offsetZ;
              }
            }
          }
          return mat;
        };

        // B. 投影行列（Projection Matrix）の拡張
        const origGetProj = x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix = function(aspect) {
          const mat = origGetProj.call(this, aspect);
          if (window.ftvrOffset) {
            const fov = window.ftvrDynamicFov || this._vf.fieldOfView || 0.785398;
            
            // FOVの変化に応じて投影行列の透視倍率（ズーム感）を動的更新
            const cotan = 1.0 / Math.tan(fov / 2.0);
            mat._11 = cotan;          // Y軸透視成分
            mat._00 = cotan / aspect;  // X軸透視成分

            // カメラからオブジェクトまでの基準距離（baseD）を算出
            let baseD = 10.0;
            if (this._vf && this._vf.position) {
              const pos = this._vf.position;
              const d = Math.hypot(pos.x, pos.y, pos.z);
              if (d > 0.001) baseD = d;
            }
            
            // 仮想画面の縦横幅（screenH, screenW）を計算
            const screenH = 2.0 * baseD * Math.tan(fov / 2.0);
            const screenW = screenH * aspect;
            
            // 投影行列のシアー成分（_02, _12）を書き換えて領域を台形に歪ませる
            mat._02 = -(2.0 * window.ftvrOffset.x) / screenW;
            mat._12 = -(2.0 * window.ftvrOffset.y) / screenH;
          }
          return mat;
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
    let currentDistanceMeters = 0;
    const baseDistanceMeters = 0.35; // 基準となる閲覧距離（35cm想定）

    // クリック可能なUIボタンの生成
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

    // UIの表示更新ルーチン
    function updateUI(statusText) {
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

    // UIクリック/タップでON/OFFトグル切り替え
    const toggleTracking = (e) => {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      isTrackingEnabled = !isTrackingEnabled;
      updateUI();
    };

    uiElement.addEventListener('pointerdown', toggleTracking);

    let targetX = 0, targetY = 0, targetZ = 0;
    let currentX = 0, currentY = 0, currentZ = 0;

    // MediaPipe FaceMesh 設定
    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });
    
    // 鼻の座標からズレ量を計算する部分およびデバイスまでの距離・動的FOV計算処理
    faceMesh.onResults((results) => {
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        const nose = landmarks[1];

        // 瞳のランドマークを取得
        const leftEye = landmarks[468] || landmarks[33];
        const rightEye = landmarks[473] || landmarks[263];

        const vw = videoElement.videoWidth || 640;
        const vh = videoElement.videoHeight || 480;

        // 画像上での両瞳間のピクセル距離を計算
        const dx = (rightEye.x - leftEye.x) * vw;
        const dy = (rightEye.y - leftEye.y) * vh;
        const distPx = Math.hypot(dx, dy);

        if (distPx > 0) {
          const realIPD = 0.063;
          const focalLength = vw * 0.85;
          const calculatedDistance = (realIPD * focalLength) / distPx;
          
          currentDistanceMeters = currentDistanceMeters === 0 
            ? calculatedDistance 
            : currentDistanceMeters * 0.85 + calculatedDistance * 0.15;

          // 距離(m)から物理視野角（FOV）を幾何計算
          const estimatedScreenHeightMeters = 0.147; // 6.1インチ画面の高さ(m)
          if (currentDistanceMeters > 0.05) {
            window.ftvrDynamicFov = 2.0 * Math.atan((estimatedScreenHeightMeters / 2.0) / currentDistanceMeters);
          }
        }

        if (isTrackingEnabled) {
          const trackingGain = 0.15; // 実寸(m)スケール感度
          targetX = -(nose.x - 0.5) * trackingGain;
          targetY = -(nose.y - 0.5) * trackingGain;
          
          // ★【追加】基準距離（35cm）からの前後移動差分（Z変位）を計算
          if (currentDistanceMeters > 0) {
            targetZ = (currentDistanceMeters - baseDistanceMeters) * 0.5; // 前後スケール調整
          }
        } else {
          targetX = 0;
          targetY = 0;
          targetZ = 0;
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

    // 4. フレームごとに滑らかに近づける部分
    function renderLoop() {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;
      currentZ += (targetZ - currentZ) * 0.12; // ★Z軸の補人

      if (Math.abs(currentX) < 0.0001) currentX = 0;
      if (Math.abs(currentY) < 0.0001) currentY = 0;
      if (Math.abs(currentZ) < 0.0001) currentZ = 0;

      // ★X, Y, Z の全ての変位を行列パッチへ渡す
      window.ftvrOffset = { x: currentX, y: currentY, z: currentZ };

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
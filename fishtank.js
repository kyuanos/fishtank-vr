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

  // 2. X3DOMの行列計算パイプライン拡張（Off-Axis射影の注入）
  function patchX3DOMPipeline() {
    if (typeof x3dom !== 'undefined' && x3dom.nodeTypes && x3dom.nodeTypes.Viewpoint) {
      if (!window.ftvrPatched) {

        // A. ビュー行列の拡張
        const origGetView = x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix = function() {
          const mat = origGetView.call(this);
          if (window.ftvrOffset && (window.ftvrOffset.x !== 0 || window.ftvrOffset.y !== 0)) {
            if (x3dom.fields && x3dom.fields.SFMatrix4f && x3dom.fields.SFMatrix4f.translation) {
              const trans = x3dom.fields.SFMatrix4f.translation(
                new x3dom.fields.SFVec3f(-window.ftvrOffset.x, -window.ftvrOffset.y, 0)
              );
              return trans.mult(mat);
            } else {
              mat._03 -= window.ftvrOffset.x;
              mat._13 -= window.ftvrOffset.y;
            }
          }
          return mat;
        };

        // B. 投影行列（Off-Axis シアー）の拡張
        const origGetProj = x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix = function(aspect) {
          const mat = origGetProj.call(this, aspect);
          if (window.ftvrOffset && (window.ftvrOffset.x !== 0 || window.ftvrOffset.y !== 0)) {
            const fov = this._vf.fieldOfView || 0.785398;
            
            let baseD = 10.0;
            if (this._vf && this._vf.position) {
              const pos = this._vf.position;
              const d = Math.hypot(pos.x, pos.y, pos.z);
              if (d > 0.001) baseD = d;
            }

            const screenH = 2.0 * baseD * Math.tan(fov / 2.0);
            const screenW = screenH * aspect;

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
      box-shadow: 0 3px 8px rgba(0,0,0,0.4);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    uiElement.innerHTML = '<span id="ftvr-status">FishTank VR 初期化中...</span>';
    document.body.appendChild(uiElement);

    const statusElem = document.getElementById('ftvr-status');

    // UIの表示更新ルーチン
    function updateUI(statusText) {
      if (!isTrackingEnabled) {
        uiElement.style.background = 'rgba(60, 60, 60, 0.85)';
        uiElement.style.color = '#ccc';
        statusElem.innerHTML = '📷 視点追従: <b style="color:#ff6b6b;">OFF</b> (クリックでON)';
      } else {
        uiElement.style.background = 'rgba(0, 0, 0, 0.85)';
        uiElement.style.color = '#6bffb8';
        statusElem.innerHTML = statusText || '📷 視点追従: <b style="color:#6bffb8;">ON</b> (クリックでOFF)';
      }
    }

    // UIクリックでON/OFFトグル切り替え
    uiElement.addEventListener('click', () => {
      isTrackingEnabled = !isTrackingEnabled;
      updateUI();
    });

    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;

    // MediaPipe FaceMesh 設定
    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });

    faceMesh.onResults((results) => {
      if (isTrackingEnabled && results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const nose = results.multiFaceLandmarks[0][1];
        const trackingGain = 5.0; // 移動感度
        targetX = -(nose.x - 0.5) * trackingGain;
        targetY = -(nose.y - 0.5) * trackingGain;
        updateUI();
      } else if (!isTrackingEnabled) {
        targetX = 0;
        targetY = 0;
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

    // 4. 描画同期ループ
    function renderLoop() {
      // OFFにした場合、滑らかに初期位置 (0, 0) に戻る
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;

      // 閾値以下の微小値は0に丸める
      if (Math.abs(currentX) < 0.0001) currentX = 0;
      if (Math.abs(currentY) < 0.0001) currentY = 0;

      // 顔追従オフセットを行列パッチへ共有
      window.ftvrOffset = { x: currentX, y: currentY };

      // X3DOMへ再描画要求
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
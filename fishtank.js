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

  // 端末ジャイロ（姿勢・傾き）の保持
  let gyroState = {
    hasGyro: false,
    pitch: 0, // X軸回転 (前後傾き)
    roll: 0,  // Y軸回転 (左右傾き)
    baseBeta: null,
    baseGamma: null
  };

  // ジャイロセンサーの監視（スマホで画面を傾けた際の補正用）
  function initOrientationSensor() {
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta !== null && e.gamma !== null) {
          gyroState.hasGyro = true;
          if (gyroState.baseBeta === null) {
            gyroState.baseBeta = e.beta;
            gyroState.baseGamma = e.gamma;
          }
          // 基準姿勢からの傾き（ラジアン）
          const dBeta = (e.beta - gyroState.baseBeta) * (Math.PI / 180);
          const dGamma = (e.gamma - gyroState.baseGamma) * (Math.PI / 180);

          // 画面の向きに応じたマッピング
          const isLandscape = window.innerWidth > window.innerHeight;
          if (isLandscape) {
            gyroState.pitch = -dGamma * 0.5;
            gyroState.roll = dBeta * 0.5;
          } else {
            gyroState.pitch = dBeta * 0.5;
            gyroState.roll = dGamma * 0.5;
          }
        }
      }, false);
    }
  }

  // キャンバスの正確なアスペクト比と物理寸法（m）を算出
  function getScreenDimensions(aspect) {
    let actAspect = aspect;
    const x3dElem = document.querySelector('x3d');
    if ((!actAspect || isNaN(actAspect)) && x3dElem && x3dElem.clientHeight > 0) {
      actAspect = x3dElem.clientWidth / x3dElem.clientHeight;
    }
    if (!actAspect || isNaN(actAspect)) {
      actAspect = window.innerWidth / window.innerHeight;
    }

    // 基準高さ（m）：スマホ〜小型モニタ実寸スケール（約8cm〜14.7cm）
    const isLandscape = actAspect >= 1.0;
    const H = isLandscape ? 0.08 : 0.147;
    // 描画キャンバスの実際のアスペクト比に完全追従
    const W = H * actAspect;

    return { W, H, aspect: actAspect };
  }

  // 2. X3DOMの行列計算パイプライン拡張（ご提示の行列式に基づく厳密な投影変換）
  function patchX3DOMPipeline() {
    if (typeof x3dom !== 'undefined' && x3dom.nodeTypes && x3dom.nodeTypes.Viewpoint) {
      if (!window.ftvrPatched) {

        // A. ビュー行列（View Matrix）の拡張
        // 透視変換を行列式側（投影行列）で直接計算するため、
        // ビュー行列は開口部中心（ワールド原点）への配置とする
        const origGetView = x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getViewMatrix = function() {
          if (window.ftvrPos) {
            // シーンのViewpointの位置（基準開口部中心）を取得
            let centerX = 0;
            let centerY = 0;
            let centerZ = 0;

            if (this._vf && this._vf.position) {
              centerX = this._vf.position.x || 0;
              centerY = this._vf.position.y || 0;
            }

            // 開口部中心への平行移動行列
            const viewMat = new x3dom.fields.SFMatrix4f();
            viewMat._00 = 1; viewMat._01 = 0; viewMat._02 = 0; viewMat._03 = -centerX;
            viewMat._10 = 0; viewMat._11 = 1; viewMat._12 = 0; viewMat._13 = -centerY;
            viewMat._20 = 0; viewMat._21 = 0; viewMat._22 = 1; viewMat._23 = -centerZ;
            viewMat._30 = 0; viewMat._31 = 0; viewMat._32 = 0; viewMat._33 = 1;

            // 端末傾き（ジャイロ）がある場合の回転合成
            if (gyroState.hasGyro && (Math.abs(gyroState.pitch) > 0.001 || Math.abs(gyroState.roll) > 0.001)) {
              const cosP = Math.cos(gyroState.pitch);
              const sinP = Math.sin(gyroState.pitch);
              const cosR = Math.cos(gyroState.roll);
              const sinR = Math.sin(gyroState.roll);

              const rotMat = new x3dom.fields.SFMatrix4f();
              rotMat._00 = cosR;        rotMat._01 = 0;    rotMat._02 = sinR;        rotMat._03 = 0;
              rotMat._10 = sinP * sinR; rotMat._11 = cosP; rotMat._12 = -sinP * cosR; rotMat._13 = 0;
              rotMat._20 = -cosP * sinR; rotMat._21 = sinP; rotMat._22 = cosP * cosR; rotMat._23 = 0;
              rotMat._30 = 0;           rotMat._31 = 0;    rotMat._32 = 0;           rotMat._33 = 1;

              return rotMat.mult(viewMat);
            }

            return viewMat;
          }
          return origGetView.call(this);
        };

        // B. 投影行列（Projection Matrix）の拡張：ご提示の行列式を完全実装
        //
        //  ( x' )   ( -ez   0       ex       0  ) ( 2/(xmax-xmin)       0       0  -(xmax+xmin)/(xmax-xmin) )
        //  ( y' ) = (  0  -ez       ey       0  ) (      0       2/(ymax-ymin) 0  -(ymax+ymin)/(ymax-ymin) )
        //  ( z' )   (  0   0   (1-ez)/zmax   0  ) (      0              0       1              0             )
        //  ( w' )   (  0   0        1       -ez ) (      0              0       0              1             )
        //
        const origGetProj = x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix;
        x3dom.nodeTypes.Viewpoint.prototype.getProjectionMatrix = function(aspect) {
          if (window.ftvrPos) {
            // 視点座標 (ex, ey, ez)
            const ex = window.ftvrPos.x || 0;
            const ey = window.ftvrPos.y || 0;
            const ez = Math.max(window.ftvrPos.z || 0.35, 0.05);

            // 画面の寸法（W, H）
            const dim = getScreenDimensions(aspect);
            const W = dim.W;
            const H = dim.H;

            // 原点を画面中心とする表示範囲 [xmin, xmax], [ymin, ymax]
            const xmin = -W / 2.0;
            const xmax =  W / 2.0;
            const ymin = -H / 2.0;
            const ymax =  H / 2.0;
            const zmax = 1.0; // 図1の Zmax = 1

            // 行列1: 透視変換行列 (M_persp)
            const M_persp = new x3dom.fields.SFMatrix4f();
            M_persp._00 = -ez; M_persp._01 = 0;   M_persp._02 = ex;               M_persp._03 = 0;
            M_persp._10 = 0;   M_persp._11 = -ez; M_persp._12 = ey;               M_persp._13 = 0;
            M_persp._20 = 0;   M_persp._21 = 0;   M_persp._22 = (1.0 - ez) / zmax; M_persp._23 = 0;
            M_persp._30 = 0;   M_persp._31 = 0;   M_persp._32 = 1.0;              M_persp._33 = -ez;

            // 行列2: 正規化（Ortho）行列 (M_ortho)
            const M_ortho = new x3dom.fields.SFMatrix4f();
            M_ortho._00 = 2.0 / (xmax - xmin); M_ortho._01 = 0;                   M_ortho._02 = 0; M_ortho._03 = -(xmax + xmin) / (xmax - xmin);
            M_ortho._10 = 0;                   M_ortho._11 = 2.0 / (ymax - ymin); M_ortho._12 = 0; M_ortho._13 = -(ymax + ymin) / (ymax - ymin);
            M_ortho._20 = 0;                   M_ortho._21 = 0;                   M_ortho._22 = 1; M_ortho._23 = 0;
            M_ortho._30 = 0;                   M_ortho._31 = 0;                   M_ortho._32 = 0; M_ortho._33 = 1;

            // 行列の積 M = M_persp * M_ortho
            const M = M_persp.mult(M_ortho);

            // WebGLクリッピング規格（w > 0）への対応
            // 式のままだと w' = z - ez < 0 となりWebGLのクリッピングでカリングされるため、
            // 斉次座標全体に -1 を掛けて w' = ez - z > 0 とする（透視除算後の x'/w', y'/w' は完全一致）
            const M_webgl = new x3dom.fields.SFMatrix4f();
            M_webgl._00 = -M._00; M_webgl._01 = -M._01; M_webgl._02 = -M._02; M_webgl._03 = -M._03;
            M_webgl._10 = -M._10; M_webgl._11 = -M._11; M_webgl._12 = -M._12; M_webgl._13 = -M._13;
            M_webgl._20 = -M._20; M_webgl._21 = -M._21; M_webgl._22 = -M._22; M_webgl._23 = -M._23;
            M_webgl._30 = -M._30; M_webgl._31 = -M._31; M_webgl._32 = -M._32; M_webgl._33 = -M._33;

            return M_webgl;
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

    initOrientationSensor();
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
          <div style="font-size:0.75rem; color:#6bffb8;">目との距離: <b>${distStr}</b></div>
        `;
      }
    }

    const toggleTracking = (e) => {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      isTrackingEnabled = !isTrackingEnabled;
      // 基準ジャイロのリセット
      gyroState.baseBeta = null;
      gyroState.baseGamma = null;
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
          const realIPD = 0.063; // 6.3cm (成人の平均瞳孔間距離)
          const focalLength = vw * 0.85;
          const calculatedDistance = (realIPD * focalLength) / distPx;

          currentDistanceMeters = currentDistanceMeters === 0
            ? calculatedDistance
            : currentDistanceMeters * 0.85 + calculatedDistance * 0.15;
        }

        if (isTrackingEnabled) {
          const Pz = Math.max(currentDistanceMeters, 0.15);

          // カメラ画角（約60度）から画面面における顔の物理X,Y位置(m)を算出
          const camFovRad = 1.047; // 60 deg
          const visibleW = 2.0 * Pz * Math.tan(camFovRad / 2.0);
          const visibleH = visibleW * (vh / vw);

          // ユーザーが右に動いたとき (nose.x が減少) -> targetPx > 0 (右へ移動)
          // ユーザーが上に動いたとき (nose.y が減少) -> targetPy > 0 (上へ移動)
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      });
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
      // 指数移動平均で視点移動を滑らかに補間
      currentPx += (targetPx - currentPx) * 0.18;
      currentPy += (targetPy - currentPy) * 0.18;
      currentPz += (targetPz - currentPz) * 0.18;

      // 算出された視点の絶対3次元位置 (m) をパイプラインへ共有
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
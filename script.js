(() => {
  "use strict";

  const canvas = document.querySelector("#gameCanvas");
  const ctx = canvas.getContext("2d");

  const dom = {
    hud: document.querySelector("#hud"),
    playerScore: document.querySelector("#playerScore"),
    cpuScore: document.querySelector("#cpuScore"),
    pauseButton: document.querySelector("#pauseButton"),
    restartButton: document.querySelector("#restartButton"),
    exitButton: document.querySelector("#exitButton"),
    safetyOverlay: document.querySelector("#safetyOverlay"),
    startButton: document.querySelector("#startButton"),
    permissionMessage: document.querySelector("#permissionMessage"),
    difficultyOptions: document.querySelector("#difficultyOptions"),
    chargeGauge: document.querySelector("#chargeGauge"),
    chargeSegments: Array.from(document.querySelectorAll(".charge-segment")),
  };

  const FIELD = {
    paddleWidth: 0.3,
    paddleDepth: 0.045,
    puckRadius: 0.027,
    maxCharge: 3,
    stopSpeed: 0.065,
    tiltMaxDegrees: 45,
    tiltDeadZoneDegrees: 4,
  };

  const DIFFICULTIES = {
    easy: {
      cpuSpeed: 0.58,
      cpuError: 0.095,
      cpuChargeStartY: 0.42,
      cpuChargeDiscipline: 0.55,
      bounceAccuracy: 0.16,
    },
    normal: {
      cpuSpeed: 0.82,
      cpuError: 0.055,
      cpuChargeStartY: 0.56,
      cpuChargeDiscipline: 0.78,
      bounceAccuracy: 0.09,
    },
    hard: {
      cpuSpeed: 1.08,
      cpuError: 0.026,
      cpuChargeStartY: 0.7,
      cpuChargeDiscipline: 1,
      bounceAccuracy: 0.04,
    },
  };

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const randomRange = (min, max) => min + Math.random() * (max - min);
  const speedOf = (puck) => Math.hypot(puck.vx, puck.vy);

  class MotionInput {
    constructor() {
      this.available = false;
      this.permissionGranted = false;
      this.tiltDegrees = 0;
      this.x = 0.5;
      this.previousX = 0.5;
      this.vx = 0;
      this.samples = 0;
      this.status = "";
      this.boundOrientation = (event) => this.handleOrientation(event);
    }

    async requestAccess() {
      const hasOrientation = "DeviceOrientationEvent" in window;
      this.available = hasOrientation;

      if (!this.available) {
        this.status = "スマホのジャイロセンサーが見つかりません。スマホブラウザで開いてください。";
        return false;
      }

      try {
        const permissionRequests = [];

        if (typeof window.DeviceOrientationEvent?.requestPermission === "function") {
          permissionRequests.push({
            type: "orientation",
            request: window.DeviceOrientationEvent.requestPermission(),
          });
        }

        const responses = await Promise.all(
          permissionRequests.map(async (item) => ({
            type: item.type,
            response: await item.request,
          })),
        );

        const denied = responses.find((item) => item.response !== "granted");
        if (denied?.type === "orientation") {
          this.status = "ジャイロセンサーの許可が必要です。";
          return false;
        }

      } catch (error) {
        this.status = "センサー許可を取得できませんでした。HTTPSのページで開いてください。";
        return false;
      }

      this.permissionGranted = true;
      this.reset();
      window.removeEventListener("deviceorientation", this.boundOrientation);
      window.addEventListener("deviceorientation", this.boundOrientation, { passive: true });
      return true;
    }

    reset() {
      this.tiltDegrees = 0;
      this.x = 0.5;
      this.previousX = 0.5;
      this.vx = 0;
      this.samples = 0;
    }

    handleOrientation(event) {
      const gamma = Number(event.gamma);
      if (!Number.isFinite(gamma)) {
        return;
      }

      this.samples += 1;
      const clampedTilt = clamp(gamma, -FIELD.tiltMaxDegrees, FIELD.tiltMaxDegrees);
      this.tiltDegrees = Math.abs(clampedTilt) <= FIELD.tiltDeadZoneDegrees ? 0 : clampedTilt;
    }

    update(dt) {
      const previousX = this.x;
      this.x = 0.5 + this.tiltDegrees / (FIELD.tiltMaxDegrees * 2);
      this.x = clamp(this.x, 0, 1);
      this.previousX = previousX;
      this.vx = dt > 0 ? (this.x - previousX) / dt : 0;
    }
  }

  class ChargeController {
    constructor() {
      this.active = false;
      this.elapsed = 0;
    }

    start() {
      if (this.active) {
        return;
      }
      this.active = true;
      this.elapsed = 0;
    }

    release() {
      this.active = false;
      this.elapsed = 0;
    }

    consume() {
      this.active = false;
      this.elapsed = 0;
    }

    update(dt) {
      if (this.active) {
        this.elapsed = clamp(this.elapsed + dt, 0, FIELD.maxCharge);
      }
    }

    ratio() {
      return clamp(this.elapsed / FIELD.maxCharge, 0, 1);
    }
  }

  class Paddle {
    constructor(side) {
      this.side = side;
      this.x = 0.5;
      this.previousX = 0.5;
      this.vx = 0;
    }

    setX(value, dt) {
      const half = FIELD.paddleWidth / 2;
      const previous = this.x;
      this.x = clamp(value, half, 1 - half);
      this.previousX = previous;
      this.vx = dt > 0 ? (this.x - previous) / dt : 0;
    }

    contains(puckX, margin = FIELD.puckRadius) {
      return Math.abs(puckX - this.x) <= FIELD.paddleWidth / 2 + margin;
    }
  }

  class Puck {
    constructor() {
      this.reset(false);
    }

    reset(randomize = true) {
      this.x = randomRange(0.44, 0.56);
      this.y = randomRange(0.46, 0.54);
      if (randomize) {
        this.launchRandom();
      } else {
        this.vx = 0;
        this.vy = 0;
      }
      this.stopped = !randomize;
      this.stopTimer = 0;
      this.trail = [];
    }

    launchRandom() {
      const angle = randomRange(-0.72, 0.72) + (Math.random() < 0.5 ? -Math.PI / 2 : Math.PI / 2);
      const speed = randomRange(0.46, 0.58);
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.stopped = false;
      this.stopTimer = 0;
      this.trail = [];
    }

    snapshotTrail() {
      this.trail.unshift({ x: this.x, y: this.y });
      if (this.trail.length > 8) {
        this.trail.pop();
      }
    }
  }

  class CpuController {
    constructor() {
      this.paddle = new Paddle("cpu");
      this.charge = new ChargeController();
      this.errorX = 0;
      this.errorTimer = 0;
    }

    reset() {
      this.paddle = new Paddle("cpu");
      this.charge.release();
      this.errorX = 0;
      this.errorTimer = 0;
    }

    update(dt, puck, difficulty) {
      const settings = DIFFICULTIES[difficulty];
      const half = FIELD.paddleWidth / 2;
      let target = 0.5;

      if (puck.vy < 0) {
        const secondsToTop = Math.abs((puck.y - FIELD.puckRadius) / Math.min(puck.vy, -0.05));
        target = puck.x + puck.vx * secondsToTop;
      }

      this.errorTimer -= dt;
      if (this.errorTimer <= 0) {
        this.errorX = randomRange(-settings.cpuError, settings.cpuError);
        this.errorTimer = randomRange(0.18, 0.3);
      }

      target = clamp(target + this.errorX, half, 1 - half);
      const delta = clamp(target - this.paddle.x, -settings.cpuSpeed * dt, settings.cpuSpeed * dt);
      this.paddle.setX(this.paddle.x + delta, dt);

      const shouldCharge = puck.vy < 0 && puck.y <= settings.cpuChargeStartY && Math.random() <= settings.cpuChargeDiscipline;
      if (shouldCharge) {
        this.charge.start();
      } else if (puck.vy >= 0 || puck.y > 0.76) {
        this.charge.release();
      }
      this.charge.update(dt);
    }
  }

  class MotionAirHockey {
    constructor(input) {
      this.input = input;
      this.player = new Paddle("player");
      this.playerCharge = new ChargeController();
      this.cpu = new CpuController();
      this.puck = new Puck();
      this.phase = "safety";
      this.difficulty = "easy";
      this.score = { player: 0, cpu: 0 };
      this.lastTime = 0;
      this.pointFlash = { top: 0, bottom: 0 };
      this.chargePointerId = null;
      this.tapStartTime = 0;
      this.wasStoppedOnPress = false;
    }

    start(difficulty) {
      this.difficulty = difficulty;
      this.score = { player: 0, cpu: 0 };
      this.player = new Paddle("player");
      this.cpu.reset();
      this.playerCharge.release();
      this.puck.reset(true);
      this.phase = "playing";
      this.updateScore();
      dom.pauseButton.textContent = "一時停止";
    }

    restart() {
      if (this.phase === "safety") {
        return;
      }
      this.input.reset();
      this.start(this.difficulty);
    }

    exit() {
      this.phase = "safety";
      this.playerCharge.release();
      this.cpu.charge.release();
      dom.hud.hidden = true;
      dom.chargeGauge.hidden = true;
      dom.safetyOverlay.hidden = false;
      dom.pauseButton.textContent = "一時停止";
      dom.permissionMessage.textContent = "";
    }

    togglePause() {
      if (this.phase === "playing") {
        this.phase = "paused";
        this.playerCharge.release();
        dom.pauseButton.textContent = "再開";
      } else if (this.phase === "paused") {
        this.phase = "playing";
        dom.pauseButton.textContent = "一時停止";
      }
    }

    updateScore() {
      dom.playerScore.textContent = String(this.score.player);
      dom.cpuScore.textContent = String(this.score.cpu);
    }

    pointTo(side) {
      this.score[side] += 1;
      this.updateScore();
      this.pointFlash[side === "player" ? "top" : "bottom"] = 0.28;
      this.playerCharge.release();
      this.cpu.charge.release();
      this.puck.reset(true);
      if (side === "player") {
        this.puck.vy = -Math.abs(this.puck.vy);
      } else {
        this.puck.vy = Math.abs(this.puck.vy);
      }
    }

    update(dt) {
      this.input.update(dt);
      this.player.setX(this.input.x, dt);
      this.updatePlayerCharge(dt);
      this.updateGauge();

      if (this.phase !== "playing") {
        return;
      }

      this.cpu.update(dt, this.puck, this.difficulty);
      this.pointFlash.top = Math.max(0, this.pointFlash.top - dt);
      this.pointFlash.bottom = Math.max(0, this.pointFlash.bottom - dt);

      if (!this.puck.stopped) {
        this.stepPuck(dt);
      }
    }

    updatePlayerCharge(dt) {
      if (this.phase !== "playing") {
        this.playerCharge.release();
        return;
      }
      this.playerCharge.update(dt);
    }

    stepPuck(dt) {
      const puck = this.puck;
      const previous = { x: puck.x, y: puck.y };
      puck.snapshotTrail();

      puck.x += puck.vx * dt;
      puck.y += puck.vy * dt;
      puck.vx *= Math.pow(0.999, dt * 60);
      puck.vy *= Math.pow(0.999, dt * 60);

      if (puck.x <= FIELD.puckRadius) {
        puck.x = FIELD.puckRadius;
        puck.vx = Math.abs(puck.vx) * 0.98;
      } else if (puck.x >= 1 - FIELD.puckRadius) {
        puck.x = 1 - FIELD.puckRadius;
        puck.vx = -Math.abs(puck.vx) * 0.98;
      }

      this.handlePaddleCollision(previous);
      this.handleGoals();
      this.detectStopped(dt);
    }

    handlePaddleCollision(previous) {
      const puck = this.puck;
      const bottomLine = 1 - FIELD.puckRadius;
      const topLine = FIELD.puckRadius;

      if (previous.y < bottomLine && puck.y >= bottomLine && puck.vy > 0) {
        if (this.player.contains(puck.x)) {
          this.reflectFromPaddle(this.player, this.playerCharge.ratio(), -1);
          this.playerCharge.consume();
          puck.y = bottomLine;
          return;
        }
      }

      if (previous.y > topLine && puck.y <= topLine && puck.vy < 0) {
        if (this.cpu.paddle.contains(puck.x)) {
          this.reflectFromPaddle(this.cpu.paddle, this.cpu.charge.ratio(), 1);
          this.cpu.charge.consume();
          puck.y = topLine;
        }
      }
    }

    reflectFromPaddle(paddle, chargeRatio, direction) {
      const puck = this.puck;
      const settings = DIFFICULTIES[this.difficulty];
      const hitOffset = clamp((puck.x - paddle.x) / (FIELD.paddleWidth / 2), -1, 1);
      const chargeBoost = 1 + chargeRatio * 1.35;
      const baseSpeed = 0.54;
      const sideAccuracy = paddle.side === "cpu" ? settings.bounceAccuracy : 0.04;
      puck.vy = direction * clamp(baseSpeed * chargeBoost + Math.abs(puck.vy) * 0.38, 0.52, 1.36);
      puck.vx = clamp(
        hitOffset * 0.38 + paddle.vx * 0.18 + randomRange(-sideAccuracy, sideAccuracy),
        -0.9,
        0.9,
      );
      puck.stopped = false;
      puck.stopTimer = 0;
    }

    handleGoals() {
      const puck = this.puck;
      if (puck.y > 1 + FIELD.puckRadius) {
        this.pointTo("cpu");
        return;
      }

      if (puck.y < -FIELD.puckRadius) {
        this.pointTo("player");
      }
    }

    detectStopped(dt) {
      const puck = this.puck;
      if (speedOf(puck) < FIELD.stopSpeed) {
        puck.stopTimer += dt;
      } else {
        puck.stopTimer = 0;
      }

      if (puck.stopTimer > 1.2) {
        puck.vx = 0;
        puck.vy = 0;
        puck.stopped = true;
        puck.x = clamp(puck.x, 0.2, 0.8);
        puck.y = clamp(puck.y, 0.28, 0.72);
      }
    }

    handleBoardPointerDown(event) {
      if (this.phase !== "playing" || this.chargePointerId !== null) {
        return;
      }
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      this.chargePointerId = event.pointerId;
      this.tapStartTime = performance.now();
      this.wasStoppedOnPress = this.puck.stopped;
      this.playerCharge.start();
    }

    handleBoardPointerUp(event) {
      if (event.pointerId !== this.chargePointerId) {
        return;
      }
      event.preventDefault();
      const tapDuration = performance.now() - this.tapStartTime;
      const shouldRelaunch = this.wasStoppedOnPress && tapDuration < 240;
      this.chargePointerId = null;
      this.playerCharge.release();
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (shouldRelaunch && this.phase === "playing") {
        this.puck.reset(true);
      }
    }

    handleBoardPointerCancel(event) {
      if (event.pointerId !== this.chargePointerId) {
        return;
      }
      this.chargePointerId = null;
      this.playerCharge.release();
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    }

    updateGauge() {
      const ratio = this.playerCharge.ratio();
      dom.chargeSegments.forEach((segment, index) => {
        segment.classList.toggle("is-active", ratio >= (index + 1) / dom.chargeSegments.length);
      });
      dom.chargeGauge.classList.toggle("is-max", ratio >= 1);
      dom.chargeGauge.style.setProperty("--charge", String(ratio));
    }
  }

  class Renderer {
    constructor(game) {
      this.game = game;
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.board = { left: 0, top: 0, width: 0, height: 0 };
    }

    resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(480, Math.round(rect.height));

      if (canvas.width === width * dpr && canvas.height === height * dpr) {
        return;
      }

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.calculateBoard();
    }

    calculateBoard() {
      const sideMargin = clamp(this.width * 0.095, 26, 52);
      const rightGaugeRoom = clamp(this.width * 0.08, 28, 48);
      const top = clamp(this.height * 0.15, 82, 128);
      const bottomMargin = clamp(this.height * 0.065, 28, 54);
      this.board = {
        left: sideMargin,
        top,
        width: this.width - sideMargin * 2 - rightGaugeRoom,
        height: this.height - top - bottomMargin,
      };
    }

    toScreen(x, y) {
      return {
        x: this.board.left + x * this.board.width,
        y: this.board.top + y * this.board.height,
      };
    }

    lengthX(value) {
      return value * this.board.width;
    }

    lengthY(value) {
      return value * this.board.height;
    }

    draw() {
      this.resize();
      this.drawBackground();
      this.drawField();
      this.drawGoals();
      this.drawTrail();
      this.drawPuck();
      this.drawPaddles();
      this.drawStoppedPulse();
      this.drawPausedVeil();
    }

    drawBackground() {
      const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
      gradient.addColorStop(0, "#121f31");
      gradient.addColorStop(1, "#070b12");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.width, this.height);

      ctx.strokeStyle = "rgba(114, 215, 255, 0.08)";
      ctx.lineWidth = 1;
      const spacing = 34;
      for (let x = 0; x <= this.width; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x - this.height * 0.18, this.height);
        ctx.stroke();
      }
    }

    drawField() {
      const b = this.board;
      ctx.fillStyle = "#101827";
      ctx.fillRect(b.left, b.top, b.width, b.height);

      const fieldGradient = ctx.createLinearGradient(0, b.top, 0, b.top + b.height);
      fieldGradient.addColorStop(0, "#17314b");
      fieldGradient.addColorStop(0.5, "#102338");
      fieldGradient.addColorStop(1, "#162540");
      ctx.fillStyle = fieldGradient;
      ctx.fillRect(b.left + 2, b.top + 2, b.width - 4, b.height - 4);

      ctx.strokeStyle = "rgba(247, 251, 255, 0.72)";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.left, b.top, b.width, b.height);

      ctx.strokeStyle = "rgba(247, 251, 255, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(b.left, b.top + b.height * 0.5);
      ctx.lineTo(b.left + b.width, b.top + b.height * 0.5);
      ctx.stroke();
    }

    drawGoals() {
      const b = this.board;
      const playerAlpha = this.game.pointFlash.bottom > 0 ? 0.46 : 0.2;
      const cpuAlpha = this.game.pointFlash.top > 0 ? 0.46 : 0.2;
      ctx.fillStyle = `rgba(255, 79, 102, ${cpuAlpha})`;
      ctx.fillRect(b.left, b.top - 5, b.width, 5);
      ctx.fillStyle = `rgba(114, 215, 255, ${playerAlpha})`;
      ctx.fillRect(b.left, b.top + b.height, b.width, 5);
    }

    drawPaddles() {
      this.drawPaddle(this.game.cpu.paddle, 0, "#ff4f66", this.game.cpu.charge.ratio());
      this.drawPaddle(this.game.player, 1, "#72d7ff", this.game.playerCharge.ratio());
    }

    drawPaddle(paddle, y, color, chargeRatio) {
      const center = this.toScreen(paddle.x, y);
      const width = this.lengthX(FIELD.paddleWidth);
      const height = clamp(this.lengthY(FIELD.paddleDepth), 12, 22);
      const top = y === 0 ? center.y - height * 0.5 : center.y - height * 0.5;
      const x = center.x - width * 0.5;
      const glow = 0.18 + chargeRatio * 0.45;

      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 16 + chargeRatio * 22;
      ctx.fillStyle = `rgba(247, 251, 255, ${glow})`;
      ctx.fillRect(x - 4, top - 4, width + 8, height + 8);
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.fillRect(x, top, width, height);
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.fillRect(x + width * 0.08, top + 3, width * 0.84, 2);
      ctx.restore();
    }

    drawTrail() {
      this.game.puck.trail.forEach((point, index) => {
        const p = this.toScreen(point.x, point.y);
        const radius = this.lengthX(FIELD.puckRadius) * (1 - index / 12);
        ctx.fillStyle = `rgba(247, 251, 255, ${(1 - index / 8) * 0.16})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    drawPuck() {
      const puck = this.game.puck;
      const p = this.toScreen(puck.x, puck.y);
      const radius = clamp(this.lengthX(FIELD.puckRadius), 7, 13);
      const glow = ctx.createRadialGradient(p.x - radius * 0.35, p.y - radius * 0.35, 1, p.x, p.y, radius);
      glow.addColorStop(0, "#ffffff");
      glow.addColorStop(0.58, "#e9f6ff");
      glow.addColorStop(1, "#80d9ff");

      ctx.fillStyle = "rgba(0, 0, 0, 0.26)";
      ctx.beginPath();
      ctx.arc(p.x + 2, p.y + 3, radius * 1.04, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    drawStoppedPulse() {
      if (!this.game.puck.stopped || this.game.phase !== "playing") {
        return;
      }

      const p = this.toScreen(this.game.puck.x, this.game.puck.y);
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08;
      ctx.strokeStyle = "rgba(255, 224, 90, 0.82)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 26 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawPausedVeil() {
      if (this.game.phase !== "paused") {
        return;
      }

      const b = this.board;
      ctx.fillStyle = "rgba(7, 12, 20, 0.42)";
      ctx.fillRect(b.left, b.top, b.width, b.height);
    }
  }

  const input = new MotionInput();
  const game = new MotionAirHockey(input);
  const renderer = new Renderer(game);

  function selectedDifficulty() {
    return dom.difficultyOptions.querySelector("input:checked")?.value || "easy";
  }

  async function startGame() {
    dom.startButton.disabled = true;
    dom.permissionMessage.textContent = "センサーを確認しています。";
    const granted = await input.requestAccess();
    dom.startButton.disabled = false;

    if (!granted) {
      dom.permissionMessage.textContent = input.status;
      return;
    }

    dom.safetyOverlay.hidden = true;
    dom.hud.hidden = false;
    dom.chargeGauge.hidden = false;
    dom.permissionMessage.textContent = "";
    game.start(selectedDifficulty());
  }

  function preventNonControlTouch(event) {
    if (!dom.safetyOverlay.hidden) {
      return;
    }

    const target = event.target;
    const isControl = target instanceof Element && target.closest("button, label, input");
    if (!isControl) {
      event.preventDefault();
    }
  }

  function bindEvents() {
    dom.startButton.addEventListener("click", startGame);
    dom.pauseButton.addEventListener("click", () => game.togglePause());
    dom.restartButton.addEventListener("click", () => game.restart());
    dom.exitButton.addEventListener("click", () => game.exit());

    canvas.addEventListener("pointerdown", (event) => game.handleBoardPointerDown(event));
    canvas.addEventListener("pointerup", (event) => game.handleBoardPointerUp(event));
    canvas.addEventListener("pointercancel", (event) => game.handleBoardPointerCancel(event));
    canvas.addEventListener("lostpointercapture", (event) => game.handleBoardPointerCancel(event));

    canvas.addEventListener("touchstart", preventNonControlTouch, { passive: false });
    canvas.addEventListener("touchmove", preventNonControlTouch, { passive: false });
    window.addEventListener("touchmove", preventNonControlTouch, { passive: false });
    window.addEventListener("resize", () => renderer.resize());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && game.phase === "playing") {
        game.togglePause();
      }
    });
  }

  function loop(time) {
    const dt = game.lastTime ? clamp((time - game.lastTime) / 1000, 0, 0.033) : 0;
    game.lastTime = time;
    game.update(dt);
    renderer.draw();
    requestAnimationFrame(loop);
  }

  bindEvents();
  renderer.resize();
  requestAnimationFrame(loop);

  window.__motionAirHockey = {
    game,
    input,
  };
})();

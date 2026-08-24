import { buildCity, WORLD, ROAD, SIDEWALK, BLOCK } from "./world";
import type { City, Rect, Billboard, Tree, Lamp, Station } from "./world";
import type { Client } from "./clients";
import { sfx } from "./audio";

export interface HudData {
  speed: number;
  found: number;
  total: number;
  time: number;
  top: number;
  fuel: number;
  fuelMax: number;
  refueling: boolean;
  stationsActive: number;
  stationsTotal: number;
}

export interface GameCallbacks {
  onHud(h: HudData): void;
  onDiscover(client: Client, index: number): void;
  onWin(stats: { time: number; top: number }): void;
  onGameOver(stats: { time: number; found: number }): void;
  onBumpKnown(): void;
  onStationUnlock(active: number, total: number, origin: "timer" | "ad"): void;
  onStationLock(active: number, total: number): void;
}

type ParticleKind = "smoke" | "spark" | "confetti" | "leaf";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: ParticleKind;
  rot: number;
}

interface Skid {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  a: number;
}

const MAX_SPEED = 640;
const ACC = 540;
const BRAKE = 780;
const REV_MAX = 215;
const CAR_R = 15;
const KMH = 0.28;
const MM = 216;
const REFUEL_RATE = 10; // л/с на работающей АЗС
const UNLOCK_DELAY_S = 1; // через сколько секунд после заправки откроется следующая АЗС (будет формулой)
const MIN_SESSION_L = 3; // меньше стольких литров «заправкой» не считается (проезд мимо)
const M_PER_PX = 0.35; // метров в мировом пикселе — для дистанций на миникарте

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(Math.round(((n >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((n & 255) * f), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const inView = (r: Rect, v: Rect, pad = 0) =>
  r.x + r.w >= v.x - pad && r.x <= v.x + v.w + pad && r.y + r.h >= v.y - pad && r.y <= v.y + v.h + pad;

export class CityRideGame {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement | null;
  private mctx: CanvasRenderingContext2D | null = null;
  private mmBase: HTMLCanvasElement;
  private city: City;
  private cb: GameCallbacks;
  private total: number;

  private raf = 0;
  private last = 0;
  private destroyed = false;
  private phase: "menu" | "play" = "menu";
  private paused = false;

  private car = { x: 0, y: 0, angle: -Math.PI / 2, speed: 0, steer: 0 };
  private braking = false;
  private keys = new Set<string>();

  private cam = { x: WORLD / 2, y: WORLD / 2, zoom: 0.66, shake: 0 };
  private vw = 300;
  private vh = 300;
  private dpr = 1;

  private wall = 0; // всегда идущее время (пульсации, качание деревьев)
  private time = 0; // игровое время заезда
  private topSpeed = 0;
  private found = 0;
  private won = false;
  private displaySpeed = 0;

  private fuel = 50;
  private readonly fuelMax = 50;
  private refueling = false;
  private stalled = false;
  private gameOverSent = false;
  private refuelSndCd = 0;
  private warnCd = 0;
  private stationsActive = 0;
  private refuelStation: Station | null = null; // где сейчас идёт заправка
  private sessionGain = 0; // сколько литров получили в текущей сессии
  private pendingUnlock = false; // ждём открытия следующей АЗС
  private unlockTimer = 0; // сколько секунд до открытия

  private particles: Particle[] = [];
  private skids: Skid[] = [];
  private prevWheelL: { x: number; y: number } | null = null;
  private prevWheelR: { x: number; y: number } | null = null;

  private bumpCd = 0;
  private knownCd = 0;
  private leafCd = 0;

  private onKeyDown: (e: KeyboardEvent) => void;
  private onKeyUp: (e: KeyboardEvent) => void;
  private onBlur: () => void;
  private onResize: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement | null,
    clients: Client[],
    cb: GameCallbacks
  ) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.mini = minimap;
    if (minimap) this.mctx = minimap.getContext("2d");
    this.city = buildCity(clients);
    this.total = this.city.billboards.length;
    this.cb = cb;
    this.placeCar();
    this.initStations();

    this.mmBase = document.createElement("canvas");
    this.mmBase.width = this.mmBase.height = MM;
    this.paintMinimapBase();

    this.onKeyDown = (e) => this.keyDown(e);
    this.onKeyUp = (e) => this.keyUp(e);
    this.onBlur = () => this.keys.clear();
    this.onResize = () => this.resize();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
    this.resize();

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------------- public API ---------------- */

  begin(): void {
    if (this.phase === "play") return;
    this.phase = "play";
    this.time = 0;
    this.topSpeed = 0;
    this.won = false;
    this.fuel = this.fuelMax;
    this.stalled = false;
    this.gameOverSent = false;
    this.refueling = false;
    this.initStations();
    sfx.engineStart();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) sfx.engineIdle();
  }

  setKey(k: "up" | "down" | "left" | "right" | "hb", v: boolean): void {
    if (v) this.keys.add(k);
    else this.keys.delete(k);
  }

  reset(): void {
    for (const b of this.city.billboards) b.discovered = false;
    this.found = 0;
    this.won = false;
    this.time = 0;
    this.topSpeed = 0;
    this.fuel = this.fuelMax;
    this.stalled = false;
    this.gameOverSent = false;
    this.refueling = false;
    this.particles = [];
    this.skids = [];
    this.placeCar();
    this.initStations();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onResize);
    sfx.engineIdle();
  }

  private placeCar(): void {
    this.car.x = this.city.roadCenters[2];
    this.car.y = WORLD * 0.66;
    this.car.angle = -Math.PI / 2;
    this.car.speed = 0;
    this.cam.x = this.car.x;
    this.cam.y = this.car.y;
  }

  /** по умолчанию работает одна АЗС — ближайшая к старту */
  private initStations(): void {
    let best: Station | null = null;
    let bd = Infinity;
    for (const s of this.city.stations) {
      s.state = "locked";
      const d = Math.hypot(s.x + s.w / 2 - this.car.x, s.y + s.h / 2 - this.car.y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best) {
      best.state = "active";
      best.origin = "start";
    }
    this.stationsActive = best ? 1 : 0;
  }

  /* ---------------- input ---------------- */

  private keyDown(e: KeyboardEvent): void {
    const map: Record<string, string> = {
      KeyW: "up",
      ArrowUp: "up",
      KeyS: "down",
      ArrowDown: "down",
      KeyA: "left",
      ArrowLeft: "left",
      KeyD: "right",
      ArrowRight: "right",
      Space: "hb",
    };
    const k = map[e.code];
    if (k) {
      e.preventDefault();
      if (!e.repeat) this.keys.add(k);
    }
  }

  private keyUp(e: KeyboardEvent): void {
    const map: Record<string, string> = {
      KeyW: "up",
      ArrowUp: "up",
      KeyS: "down",
      ArrowDown: "down",
      KeyA: "left",
      ArrowLeft: "left",
      KeyD: "right",
      ArrowRight: "right",
      Space: "hb",
    };
    const k = map[e.code];
    if (k) this.keys.delete(k);
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.vw = this.cv.clientWidth || 300;
    this.vh = this.cv.clientHeight || 300;
    this.cv.width = Math.round(this.vw * this.dpr);
    this.cv.height = Math.round(this.vh * this.dpr);
  }

  /* ---------------- loop ---------------- */

  private loop = (ts: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = clamp((ts - this.last) / 1000 || 0.016, 0.001, 0.033);
    this.last = ts;
    this.wall += dt;
    if (this.phase === "play" && !this.paused) this.update(dt);
    this.render(dt);
  };

  /* ---------------- simulation ---------------- */

  private update(dt: number): void {
    this.time += dt;
    this.bumpCd -= dt;
    this.knownCd -= dt;
    this.leafCd -= dt;

    const c = this.car;
    const up = this.keys.has("up");
    const down = this.keys.has("down");
    const left = this.keys.has("left");
    const right = this.keys.has("right");
    const hb = this.keys.has("hb");
    let throttle = 0;

    if (up && !this.stalled) {
      c.speed += ACC * dt;
      throttle = 1;
    }
    if (down) {
      if (c.speed > 1) {
        c.speed -= BRAKE * dt;
        this.braking = true;
      } else if (!this.stalled) {
        c.speed -= ACC * 0.55 * dt;
        this.braking = false;
        throttle = 0.5;
      } else {
        this.braking = false;
      }
    } else {
      this.braking = false;
    }
    if (!up && !down) {
      const s = c.speed;
      c.speed = s - Math.sign(s) * Math.min(Math.abs(s), (55 + Math.abs(s) * 0.85) * dt);
    }
    if (hb) c.speed -= c.speed * 2.4 * dt;
    // заглохший мотор: машина докатывается
    if (this.stalled) c.speed -= c.speed * Math.min(1, 1.5 * dt);

    // трава тормозит
    if (!this.isOnRoad(c.x, c.y)) {
      const s = c.speed;
      if (Math.abs(s) > 250) c.speed = s - Math.sign(s) * 560 * dt;
      else c.speed = s - Math.sign(s) * Math.min(Math.abs(s), 150 * dt);
      if (Math.abs(s) > 70 && Math.random() < 0.4) {
        this.spawn(c.x - Math.cos(c.angle) * 16, c.y - Math.sin(c.angle) * 16, "smoke", "rgba(128,138,116,0.4)", 1, 50);
      }
    }
    c.speed = clamp(c.speed, -REV_MAX, MAX_SPEED);

    // руль
    const dir = (left ? -1 : 0) + (right ? 1 : 0);
    const sp = Math.abs(c.speed);
    let grip = Math.min(sp / 150, 1) * (1 - 0.42 * (sp / MAX_SPEED));
    if (hb) grip *= 1.75;
    c.angle += dir * 3.1 * grip * (c.speed < -1 ? -1 : 1) * dt;
    c.steer += (dir - c.steer) * Math.min(1, 10 * dt);

    // следы юза
    const skidding = (hb && sp > 140) || (dir !== 0 && sp > MAX_SPEED * 0.68);
    const hx = Math.cos(c.angle);
    const hy = Math.sin(c.angle);
    const px = -hy;
    const py = hx;
    if (skidding) {
      const rl = { x: c.x - hx * 13 + px * 8, y: c.y - hy * 13 + py * 8 };
      const rr = { x: c.x - hx * 13 - px * 8, y: c.y - hy * 13 - py * 8 };
      if (this.prevWheelL && this.prevWheelR) {
        this.pushSkid(this.prevWheelL, rl);
        this.pushSkid(this.prevWheelR, rr);
      }
      this.prevWheelL = rl;
      this.prevWheelR = rr;
    } else {
      this.prevWheelL = this.prevWheelR = null;
    }

    // движение
    c.x += hx * c.speed * dt;
    c.y += hy * c.speed * dt;

    // выхлоп
    if (up && Math.random() < 0.55) {
      this.spawn(
        c.x - hx * 22 + (Math.random() - 0.5) * 6,
        c.y - hy * 22 + (Math.random() - 0.5) * 6,
        "smoke",
        "rgba(150,160,178,0.4)",
        0.6,
        34
      );
    }

    this.collide();
    this.updateFuel(dt);
    this.updateParticles(dt);

    // затухание следов
    for (let i = this.skids.length - 1; i >= 0; i--) {
      this.skids[i].a -= dt * 0.05;
      if (this.skids[i].a <= 0) this.skids.splice(i, 1);
    }

    this.topSpeed = Math.max(this.topSpeed, sp);
    this.displaySpeed += (sp - this.displaySpeed) * Math.min(1, 8 * dt);

    if (this.stalled) sfx.engineIdle();
    else sfx.engine(sp / MAX_SPEED, throttle);
    this.cb.onHud({
      speed: Math.round(this.displaySpeed * KMH),
      found: this.found,
      total: this.total,
      time: this.time,
      top: Math.round(this.topSpeed * KMH),
      fuel: this.fuel,
      fuelMax: this.fuelMax,
      refueling: this.refueling,
      stationsActive: this.stationsActive,
      stationsTotal: this.city.stations.length,
    });
  }

  /* -------- топливо: расход, заправка, глохнем -------- */

  private updateFuel(dt: number): void {
    const c = this.car;
    const sp = Math.abs(c.speed);
    const speed01 = sp / MAX_SPEED;
    const up = this.keys.has("up");
    const burn =
      0.05 +
      (up && !this.stalled ? 0.24 + speed01 * 0.28 : 0) +
      (this.keys.has("hb") && sp > 250 ? 0.22 : 0);
    if (!this.stalled) {
      this.fuel = Math.max(0, this.fuel - burn * dt);
      if (this.fuel <= 0) {
        this.stalled = true;
        this.refueling = false;
        this.cam.shake = Math.min(14, this.cam.shake + 9);
        sfx.stall();
        for (let i = 0; i < 16; i++) {
          this.spawn(c.x, c.y, "smoke", "rgba(120,126,138,0.5)", 1.1, 60);
        }
      }
    } else {
      if (sp > 30 && Math.random() < dt * 12) {
        this.spawn(
          c.x - Math.cos(c.angle) * 18,
          c.y - Math.sin(c.angle) * 18,
          "smoke",
          "rgba(105,112,124,0.5)",
          1,
          40
        );
      }
      if (sp < 24 && !this.gameOverSent) {
        this.gameOverSent = true;
        this.cb.onGameOver({ time: this.time, found: this.found });
      }
    }
    // отложенное открытие следующей АЗС (после заправки на «обычной» станции)
    if (this.pendingUnlock) {
      this.unlockTimer -= dt;
      if (this.unlockTimer <= 0) {
        this.pendingUnlock = false;
        this.unlockRandom("timer");
      }
    }
    // заправка: только на работающих АЗС, REFUEL_RATE л/с
    let at: Station | null = null;
    if (!this.stalled) {
      for (const s of this.city.stations) {
        if (s.state !== "active") continue;
        if (c.x > s.x - 6 && c.x < s.x + s.w + 6 && c.y > s.y - 6 && c.y < s.y + s.h + 6) {
          at = s;
          break;
        }
      }
    }
    if (at && this.fuel < this.fuelMax) {
      if (this.refuelStation !== at) {
        this.endRefuelSession(); // переехали на другую колонку — закрываем прежнюю сессию
        this.refuelStation = at;
        this.sessionGain = 0;
      }
      const was = this.fuel;
      this.fuel = Math.min(this.fuelMax, this.fuel + REFUEL_RATE * dt);
      this.sessionGain += this.fuel - was;
      this.refueling = true;
      this.refuelSndCd -= dt;
      if (this.refuelSndCd <= 0) {
        sfx.blip();
        this.refuelSndCd = 0.15;
      }
      if (Math.random() < dt * 24) {
        this.spawn(c.x + (Math.random() - 0.5) * 26, c.y + (Math.random() - 0.5) * 26, "spark", "#7ee08a", 0.6, 70);
      }
      if (was < this.fuelMax && this.fuel >= this.fuelMax) {
        sfx.tankFull();
        for (let i = 0; i < 22; i++) {
          this.spawn(c.x, c.y - 10, "confetti", i % 2 ? "#7ee08a" : "#ffe08a", 0.9, 300);
        }
      }
    } else {
      this.refueling = false;
      if (this.refuelStation) this.endRefuelSession(); // сессия закончилась — станция закрывается
    }
    // предупреждение о низком баке
    if (!this.stalled && this.fuel < this.fuelMax * 0.22 && this.fuel > 0) {
      this.warnCd -= dt;
      if (this.warnCd <= 0) {
        sfx.warn();
        this.warnCd = 1.7;
      }
    }
  }

  /** конец сессии заправки: станция, отдавшая топливо, блокируется */
  private endRefuelSession(): void {
    const s = this.refuelStation;
    this.refuelStation = null;
    const gained = this.sessionGain;
    this.sessionGain = 0;
    if (!s || gained < MIN_SESSION_L) return; // короткий проезд мимо — не считается
    if (s.state !== "active") return;
    s.state = "locked";
    this.stationsActive = Math.max(0, this.stationsActive - 1);
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2 - 20;
    for (let i = 0; i < 12; i++) {
      this.spawn(cx, cy, "smoke", "rgba(112,118,130,0.55)", 1.15, 55);
    }
    sfx.stationLock();
    this.cb.onStationLock(this.stationsActive, this.city.stations.length);
    // станции, открытые за рекламу, не запускают цепочку — новая АЗС не открывается
    if (s.origin !== "ad" && this.city.stations.some((x) => x.state === "locked")) {
      this.pendingUnlock = true;
      this.unlockTimer = UNLOCK_DELAY_S;
    }
  }

  /** открыть случайную АЗС из закрытых (по таймеру или за просмотр рекламы) */
  private unlockRandom(origin: "timer" | "ad"): void {
    const locked = this.city.stations.filter((x) => x.state === "locked");
    if (!locked.length) return;
    const st = locked[Math.floor(Math.random() * locked.length)];
    st.state = "active";
    st.origin = origin;
    this.stationsActive += 1;
    const cx = st.x + st.w / 2;
    const cy = st.y + st.h / 2;
    for (let i = 0; i < 18; i++) {
      this.spawn(cx, cy, "spark", i % 2 ? "#ffd27a" : "#7ee08a", 0.8, 260);
    }
    sfx.unlock();
    this.cb.onStationUnlock(this.stationsActive, this.city.stations.length, origin);
  }

  private pushSkid(a: { x: number; y: number }, b: { x: number; y: number }): void {
    this.skids.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, a: 0.5 });
    if (this.skids.length > 640) this.skids.splice(0, this.skids.length - 640);
  }

  private isOnRoad(x: number, y: number): boolean {
    return this.city.roadCenters.some((c) => Math.abs(x - c) < ROAD / 2 || Math.abs(y - c) < ROAD / 2);
  }

  private collide(): void {
    const c = this.car;
    let hit = false;

    for (const b of this.city.buildings) {
      if (this.resolveRect(b)) hit = true;
    }
    for (const b of this.city.billboards) {
      if (this.resolveRect(b)) {
        if (!b.discovered) this.discover(b);
        else if (this.knownCd <= 0) {
          this.knownCd = 1.4;
          this.cb.onBumpKnown();
        }
      }
    }
    // деревья (мягко, по «стволу»)
    for (const t of this.city.trees) {
      const dx = c.x - t.x;
      const dy = c.y - t.y;
      const rr = CAR_R + t.r * 0.4;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        c.x += (dx / d) * (rr - d);
        c.y += (dy / d) * (rr - d);
        c.speed *= 0.72;
        if (this.leafCd <= 0) {
          this.leafCd = 0.4;
          for (let i = 0; i < 6; i++) this.spawn(t.x, t.y - 10, "leaf", "#4d8a5c", 0.7, 90);
        }
      }
    }
    // границы мира
    const W = WORLD;
    if (c.x < CAR_R + 20) {
      c.x = CAR_R + 20;
      hit = true;
    }
    if (c.x > W - CAR_R - 20) {
      c.x = W - CAR_R - 20;
      hit = true;
    }
    if (c.y < CAR_R + 20) {
      c.y = CAR_R + 20;
      hit = true;
    }
    if (c.y > W - CAR_R - 20) {
      c.y = W - CAR_R - 20;
      hit = true;
    }

    if (hit) {
      const sp = Math.abs(c.speed);
      if (sp > 70) {
        c.speed *= 0.42;
        this.cam.shake = Math.min(14, 5 + sp * 0.012);
        for (let i = 0; i < 9; i++) {
          this.spawn(c.x + Math.cos(c.angle) * 14, c.y + Math.sin(c.angle) * 14, "spark", i % 2 ? "#ffd27a" : "#c9cdd6", 0.35, 210);
        }
        if (this.bumpCd <= 0) {
          this.bumpCd = 0.28;
          sfx.thud();
        }
      } else {
        c.speed *= 0.78;
      }
    }
  }

  private resolveRect(r: Rect): boolean {
    const c = this.car;
    const px = clamp(c.x, r.x, r.x + r.w);
    const py = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - px;
    const dy = c.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= CAR_R * CAR_R) return false;
    const d = Math.sqrt(d2);
    if (d < 0.001) {
      const l = c.x - r.x;
      const rt = r.x + r.w - c.x;
      const t = c.y - r.y;
      const bt = r.y + r.h - c.y;
      const m = Math.min(l, rt, t, bt);
      if (m === l) c.x = r.x - CAR_R;
      else if (m === rt) c.x = r.x + r.w + CAR_R;
      else if (m === t) c.y = r.y - CAR_R;
      else c.y = r.y + r.h + CAR_R;
    } else {
      const push = (CAR_R - d) / d;
      c.x += dx * push;
      c.y += dy * push;
    }
    return true;
  }

  private discover(b: Billboard): void {
    b.discovered = true;
    this.found += 1;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2 - 20;
    const colors = [b.client.color, "#fdf3e0", "#ffd27a", shade(b.client.color, 0.75)];
    for (let i = 0; i < 30; i++) {
      this.spawn(cx, cy, "confetti", colors[i % colors.length], 0.95, 330);
    }
    sfx.chime();
    this.unlockRandom("ad"); // просмотр рекламы активирует ещё одну АЗС
    this.cb.onDiscover(b.client, this.found);
    if (this.found >= this.total && !this.won) {
      this.won = true;
      sfx.win();
      this.cb.onWin({ time: this.time, top: Math.round(this.topSpeed * KMH) });
    }
  }

  /* ---------------- particles ---------------- */

  private spawn(x: number, y: number, kind: ParticleKind, color: string, life: number, vel: number): void {
    if (this.particles.length > 420) this.particles.shift();
    const a = Math.random() * Math.PI * 2;
    const v = vel * (0.35 + Math.random() * 0.65);
    this.particles.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life,
      max: life,
      size: kind === "smoke" ? 5 + Math.random() * 5 : 3 + Math.random() * 4,
      color,
      kind,
      rot: Math.random() * Math.PI,
    });
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.4 * dt;
      p.vy *= 1 - 2.4 * dt;
      if (p.kind === "smoke") p.size += 9 * dt;
      p.rot += dt * 6;
    }
  }

  /* ---------------- render ---------------- */

  private render(dt: number): void {
    const { ctx } = this;
    const w = this.vw;
    const h = this.vh;

    // камера
    let tx: number;
    let ty: number;
    let tz: number;
    if (this.phase === "menu") {
      const t = this.wall * 0.055;
      tx = WORLD / 2 + Math.cos(t) * WORLD * 0.26;
      ty = WORLD / 2 + Math.sin(t * 0.77) * WORLD * 0.24;
      tz = 0.66;
    } else {
      const sp = Math.abs(this.car.speed);
      tx = this.car.x + Math.cos(this.car.angle) * sp * 0.33;
      ty = this.car.y + Math.sin(this.car.angle) * sp * 0.33;
      tz = 1.04 - (sp / MAX_SPEED) * 0.22;
    }
    const kp = 1 - Math.exp(-6 * dt);
    const kz = 1 - Math.exp(-3 * dt);
    this.cam.x += (tx - this.cam.x) * kp;
    this.cam.y += (ty - this.cam.y) * kp;
    this.cam.zoom += (tz - this.cam.zoom) * kz;
    this.cam.shake *= Math.exp(-7 * dt);

    const zoom = this.cam.zoom;
    const shx = (Math.random() - 0.5) * this.cam.shake;
    const shy = (Math.random() - 0.5) * this.cam.shake;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0d1420";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2 + shx, h / 2 + shy);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    const pad = 60;
    const vis: Rect = {
      x: this.cam.x - w / 2 / zoom - pad,
      y: this.cam.y - h / 2 / zoom - pad,
      w: w / zoom + pad * 2,
      h: h / zoom + pad * 2,
    };

    this.drawGround(vis);
    this.drawRoads(vis);
    this.drawStations(vis);
    this.drawSkids(vis);
    this.drawBillboardsLayer(vis);
    this.drawTrees(vis);
    this.drawBuildings(vis);
    this.drawLamps(vis);
    this.drawParticles("smoke");
    this.drawCar();
    this.drawParticles("solid");
    this.lightPass(vis);

    // виньетка
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.72);
    vg.addColorStop(0, "rgba(4,7,18,0)");
    vg.addColorStop(1, "rgba(4,7,18,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    this.drawMinimap();
  }

  private drawGround(vis: Rect): void {
    const { ctx } = this;
    const gx = Math.max(vis.x, -80);
    const gy = Math.max(vis.y, -80);
    const gw = Math.min(vis.x + vis.w, WORLD + 80) - gx;
    const gh = Math.min(vis.y + vis.h, WORLD + 80) - gy;
    ctx.fillStyle = "#2b4233";
    ctx.fillRect(gx, gy, gw, gh);

    // кварталы: тротуар + внутренняя часть
    for (const b of this.city.blocks) {
      if (!inView(b, vis)) continue;
      ctx.fillStyle = "#49515f";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#5d6678";
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
      const park = this.city.parks.find((p) => p.x === b.x && p.y === b.y);
      const ix = b.x + SIDEWALK;
      const iy = b.y + SIDEWALK;
      const iw = b.w - SIDEWALK * 2;
      if (park) {
        ctx.fillStyle = "#31513d";
        ctx.fillRect(ix, iy, iw, iw);
        ctx.fillStyle = "rgba(226,255,238,0.05)";
        for (let sy = iy; sy < iy + iw; sy += 64) ctx.fillRect(ix, sy, iw, 26);
        if (park.pond) {
          ctx.fillStyle = "#23455c";
          ctx.beginPath();
          ctx.ellipse(park.pond.x, park.pond.y, park.pond.r * 1.15, park.pond.r, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#31586e";
          ctx.lineWidth = 5;
          ctx.stroke();
          ctx.fillStyle = "rgba(120,180,210,0.14)";
          ctx.beginPath();
          ctx.ellipse(park.pond.x - park.pond.r * 0.2, park.pond.y - park.pond.r * 0.2, park.pond.r * 0.5, park.pond.r * 0.38, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = "#3e4653";
        ctx.fillRect(ix, iy, iw, iw);
      }
    }

    // граница мира
    ctx.strokeStyle = "#3f4655";
    ctx.lineWidth = 24;
    ctx.strokeRect(0, 0, WORLD, WORLD);
    ctx.strokeStyle = "#59627a";
    ctx.lineWidth = 3;
    ctx.strokeRect(14, 14, WORLD - 28, WORLD - 28);
  }

  private drawRoads(vis: Rect): void {
    const { ctx } = this;
    const centers = this.city.roadCenters;
    ctx.fillStyle = "#23272f";
    for (const c of centers) {
      if (c + ROAD / 2 >= vis.x && c - ROAD / 2 <= vis.x + vis.w) ctx.fillRect(c - ROAD / 2, 0, ROAD, WORLD);
      if (c + ROAD / 2 >= vis.y && c - ROAD / 2 <= vis.y + vis.h) ctx.fillRect(0, c - ROAD / 2, WORLD, ROAD);
    }
    // кромки
    ctx.strokeStyle = "#3a4250";
    ctx.lineWidth = 3;
    for (const c of centers) {
      if (c + ROAD / 2 >= vis.x && c - ROAD / 2 <= vis.x + vis.w) {
        this.vline(c - ROAD / 2 + 5, vis);
        this.vline(c + ROAD / 2 - 5, vis);
      }
      if (c + ROAD / 2 >= vis.y && c - ROAD / 2 <= vis.y + vis.h) {
        this.hline(c - ROAD / 2 + 5, vis);
        this.hline(c + ROAD / 2 - 5, vis);
      }
    }
    // осевая разметка (пунктир), сегментами между перекрёстками
    ctx.strokeStyle = "rgba(217,181,88,0.7)";
    ctx.lineWidth = 4;
    ctx.setLineDash([30, 36]);
    for (const c of centers) {
      for (let j = 0; j < centers.length - 1; j++) {
        const y0 = centers[j] + ROAD / 2 + 10;
        const y1 = centers[j + 1] - ROAD / 2 - 10;
        if (c >= vis.x && c <= vis.x + vis.w && y1 >= vis.y && y0 <= vis.y + vis.h) {
          ctx.beginPath();
          ctx.moveTo(c, Math.max(y0, vis.y - 40));
          ctx.lineTo(c, Math.min(y1, vis.y + vis.h + 40));
          ctx.stroke();
        }
        const x0 = centers[j] + ROAD / 2 + 10;
        const x1 = centers[j + 1] - ROAD / 2 - 10;
        if (c >= vis.y && c <= vis.y + vis.h && x1 >= vis.x && x0 <= vis.x + vis.w) {
          ctx.beginPath();
          ctx.moveTo(Math.max(x0, vis.x - 40), c);
          ctx.lineTo(Math.min(x1, vis.x + vis.w + 40), c);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    // зебры на перекрёстках
    ctx.fillStyle = "rgba(226,232,240,0.3)";
    for (const cx of centers) {
      for (const cy of centers) {
        if (Math.abs(cx - this.cam.x) > vis.w / 2 + ROAD || Math.abs(cy - this.cam.y) > vis.h / 2 + ROAD) continue;
        const e = ROAD / 2;
        // подходы по вертикальной дороге (полосы вдоль оси Y)
        for (let k = 0; k < 7; k++) {
          const sx = cx - e + 14 + k * 21;
          ctx.fillRect(sx, cy - e - 56, 11, 44);
          ctx.fillRect(sx, cy + e + 12, 11, 44);
        }
        // подходы по горизонтальной
        for (let k = 0; k < 7; k++) {
          const sy = cy - e + 14 + k * 21;
          ctx.fillRect(cx - e - 56, sy, 44, 11);
          ctx.fillRect(cx + e + 12, sy, 44, 11);
        }
      }
    }
  }

  private vline(x: number, vis: Rect): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x, Math.max(0, vis.y - 40));
    ctx.lineTo(x, Math.min(WORLD, vis.y + vis.h + 40));
    ctx.stroke();
  }

  private hline(y: number, vis: Rect): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(Math.max(0, vis.x - 40), y);
    ctx.lineTo(Math.min(WORLD, vis.x + vis.w + 40), y);
    ctx.stroke();
  }

  private drawStations(vis: Rect): void {
    const { ctx } = this;
    for (const s of this.city.stations) {
      if (!inView(s, vis, 130)) continue;
      const active = s.state === "active";
      const left = s.corner === 0 || s.corner === 2;
      const top = s.corner === 0 || s.corner === 1;
      const cxw = s.x + s.w / 2;
      const cyw = s.y + s.h / 2;

      /* въезды через тротуар */
      ctx.fillStyle = "#262b34";
      if (left) ctx.fillRect(s.bx - 4, cyw - 46, s.x - (s.bx - 4), 92);
      else ctx.fillRect(s.x + s.w, cyw - 46, s.bx + BLOCK + 4 - (s.x + s.w), 92);
      if (top) ctx.fillRect(cxw - 46, s.by - 4, 92, s.y - (s.by - 4));
      else ctx.fillRect(cxw - 46, s.y + s.h, 92, s.by + BLOCK + 4 - (s.y + s.h));

      /* площадка */
      ctx.fillStyle = active ? "#2e343e" : "#272c34";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
      /* бордюр: рабочий — красно-белый, пустой — серый с тускло-красным */
      ctx.strokeStyle = active ? "#c8ccd2" : "#565d68";
      ctx.lineWidth = 4;
      ctx.strokeRect(s.x + 4, s.y + 4, s.w - 8, s.h - 8);
      ctx.save();
      ctx.strokeStyle = active ? "#d8452f" : "#7a3a30";
      ctx.setLineDash([14, 14]);
      ctx.strokeRect(s.x + 4, s.y + 4, s.w - 8, s.h - 8);
      ctx.restore();
      /* разметка */
      ctx.strokeStyle = active ? "rgba(230,225,210,0.22)" : "rgba(230,225,210,0.09)";
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 10]);
      ctx.strokeRect(s.x + 20, s.y + 20, s.w - 40, s.h - 40);
      ctx.setLineDash([]);

      /* колонки */
      for (let i = 0; i < 2; i++) {
        const px = s.x + s.w * (0.34 + i * 0.32);
        const py = s.y + s.h * 0.74;
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(px - 8 + 3, py - 15 + 3, 16, 30);
        ctx.fillStyle = active ? "#d8dde2" : "#5d646e";
        ctx.fillRect(px - 8, py - 15, 16, 30);
        ctx.fillStyle = active ? "#f2a93b" : "#7a5a30";
        ctx.fillRect(px - 8, py - 15, 16, 8);
        ctx.fillStyle = active ? "#3a414d" : "#232830";
        ctx.fillRect(px - 5, py - 2, 10, 9);
      }

      /* навес */
      const rw = 120;
      const rh = 72;
      const rx = cxw - rw / 2;
      const ry = cyw - rh / 2;
      ctx.fillStyle = "rgba(6,9,18,0.4)";
      ctx.fillRect(rx + 8, ry + 10, rw, rh);
      ctx.fillStyle = active ? "#8f979f" : "#4a515b";
      const posts: Array<[number, number]> = [
        [0.1, 0.14],
        [0.9, 0.14],
        [0.1, 0.86],
        [0.9, 0.86],
      ];
      for (const [fx, fy] of posts) ctx.fillRect(rx + rw * fx - 3, ry + rh * fy - 3, 6, 6);
      ctx.fillStyle = active ? "#e9edf0" : "#3b414b";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = active ? "#d33d2a" : "#6e3a33";
      ctx.fillRect(rx, ry, rw, 10);
      ctx.fillRect(rx, ry + rh - 10, rw, 10);
      ctx.strokeStyle = active ? "rgba(255,120,80,0.5)" : "rgba(120,80,70,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(rx - 1, ry - 1, rw + 2, rh + 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (active) {
        ctx.fillStyle = "#b3402e";
        ctx.font = '17px "Russo One"';
        ctx.fillText("ОКТАН", cxw, cyw + 1);
      } else {
        ctx.fillStyle = "#d0604e";
        ctx.font = '12px "Russo One"';
        ctx.fillText("НЕТ ТОПЛИВА", cxw, cyw + 1);
      }

      /* вертикальная стела «АЗС» у въезда */
      const pulse = 0.55 + 0.45 * Math.sin(this.wall * 3.4 + s.x * 0.01);
      const bw = 20;
      const bh = 86;
      const bx = left ? s.x - 26 : s.x + s.w + 6;
      const by = cyw - bh / 2;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(bx + 3, by + 3, bw, bh);
      ctx.fillStyle = "#14181f";
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = active ? `rgba(255,150,60,${0.45 + 0.55 * pulse})` : "rgba(120,80,70,0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = active ? `rgba(255,176,80,${0.6 + 0.4 * pulse})` : "rgba(130,138,150,0.55)";
      ctx.font = '12px "Russo One"';
      const letters = ["А", "З", "С"];
      letters.forEach((ch, i) => ctx.fillText(ch, bx + bw / 2, by + 18 + i * 22));
      if (!active) {
        // мигающая красная точка — топлива нет
        ctx.fillStyle = `rgba(232,86,70,${0.35 + 0.65 * pulse})`;
        ctx.beginPath();
        ctx.arc(bx + bw / 2, by + bh - 12, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  private drawSkids(vis: Rect): void {
    const { ctx } = this;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    for (const s of this.skids) {
      if (Math.max(s.x1, s.x2) < vis.x || Math.min(s.x1, s.x2) > vis.x + vis.w) continue;
      if (Math.max(s.y1, s.y2) < vis.y || Math.min(s.y1, s.y2) > vis.y + vis.h) continue;
      ctx.strokeStyle = `rgba(16,18,24,${s.a})`;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  }

  private drawBillboardsLayer(vis: Rect): void {
    const { ctx } = this;
    this.city.billboards.forEach((b, idx) => {
      if (!inView(b, vis, 80)) return;
      const cx = b.x + b.w / 2;
      const lift = 26;
      // тень
      ctx.fillStyle = "rgba(6,9,18,0.42)";
      ctx.beginPath();
      ctx.ellipse(cx + 9, b.y + b.h - 2, b.w * 0.52, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      // опоры
      ctx.fillStyle = "#161a23";
      ctx.fillRect(b.x + b.w * 0.24 - 3, b.y + b.h - lift, 6, lift + 2);
      ctx.fillRect(b.x + b.w * 0.76 - 3, b.y + b.h - lift, 6, lift + 2);
      // рама
      const px = b.x;
      const py = b.y - lift;
      ctx.fillStyle = "#0f1420";
      ctx.fillRect(px - 5, py - 5, b.w + 10, b.h + 10);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (!b.discovered) {
        ctx.fillStyle = "#141a26";
        ctx.fillRect(px, py, b.w, b.h);
        const pulse = 0.5 + 0.5 * Math.sin(this.wall * 3 + idx * 1.7);
        ctx.strokeStyle = `rgba(255,183,84,${0.3 + 0.5 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([10, 7]);
        ctx.strokeRect(px + 5, py + 5, b.w - 10, b.h - 10);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffcf7d";
        ctx.font = `${b.vertical ? 13 : 17}px "Russo One"`;
        ctx.fillText("СВОБОДНО", cx, py + b.h / 2 - (b.vertical ? 4 : 9));
        if (!b.vertical) {
          ctx.fillStyle = "rgba(255,207,125,0.6)";
          ctx.font = "500 11px Rubik";
          ctx.fillText("место для вашей рекламы", cx, py + b.h / 2 + 13);
        }
      } else {
        const cl = b.client;
        ctx.fillStyle = cl.color;
        ctx.fillRect(px, py, b.w, b.h);
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.fillRect(px, py, b.w, 8);
        ctx.fillStyle = cl.ink;
        ctx.font = `${b.vertical ? 25 : 31}px "Russo One"`;
        ctx.fillText(cl.mark, cx, py + b.h / 2 - (b.vertical ? 22 : 9));
        // нижняя плашка с названием
        ctx.fillStyle = "rgba(8,10,18,0.3)";
        ctx.fillRect(px, py + b.h - 21, b.w, 21);
        ctx.save();
        ctx.beginPath();
        ctx.rect(px + 2, py + b.h - 21, b.w - 4, 21);
        ctx.clip();
        ctx.fillStyle = cl.ink;
        ctx.font = "600 11px Rubik";
        ctx.fillText(cl.name, cx, py + b.h - 10);
        ctx.restore();
        // зелёная отметка «подписано»
        ctx.fillStyle = "#3ddc84";
        ctx.beginPath();
        ctx.arc(px + b.w - 1, py + 1, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#0c2b18";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(px + b.w - 6, py + 1);
        ctx.lineTo(px + b.w - 2, py + 5);
        ctx.lineTo(px + b.w + 4, py - 3);
        ctx.stroke();
      }
    });
  }

  private drawTrees(vis: Rect): void {
    const { ctx } = this;
    for (const t of this.city.trees) {
      if (t.x < vis.x - 60 || t.x > vis.x + vis.w + 60 || t.y < vis.y - 60 || t.y > vis.y + vis.h + 60) continue;
      const sway = Math.sin(this.wall * 1.4 + t.x * 0.013) * 2;
      ctx.fillStyle = "rgba(6,10,18,0.34)";
      ctx.beginPath();
      ctx.ellipse(t.x + 7, t.y + 9, t.r * 1.02, t.r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#2c5a3c";
      ctx.beginPath();
      ctx.arc(t.x + sway, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3a7050";
      ctx.beginPath();
      ctx.arc(t.x + sway - t.r * 0.18, t.y - t.r * 0.2, t.r * 0.66, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(150,210,160,0.25)";
      ctx.beginPath();
      ctx.arc(t.x + sway - t.r * 0.3, t.y - t.r * 0.34, t.r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBuildings(vis: Rect): void {
    const { ctx } = this;
    for (const b of this.city.buildings) {
      if (!inView(b, vis, 90)) continue;
      const dx = -b.hgt * 0.3;
      const dy = -b.hgt * 0.42;
      // тень
      ctx.fillStyle = "rgba(7,9,18,0.34)";
      ctx.fillRect(b.x + 10, b.y + 12, b.w, b.h);
      // южный торец
      ctx.fillStyle = shade(b.c, 0.52);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.h);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x + b.w + dx, b.y + b.h + dy);
      ctx.lineTo(b.x + dx, b.y + b.h + dy);
      ctx.closePath();
      ctx.fill();
      // окна на южном торце
      const n = 10;
      const step = b.w / (n + 1);
      const wh = Math.max(5, -dy * 0.56);
      for (let i = 0; i < n; i++) {
        const lit = (b.winMask >> i) & 1;
        ctx.fillStyle = lit ? "rgba(255,203,118,0.9)" : "rgba(14,19,30,0.6)";
        ctx.fillRect(b.x + step * (i + 1) - 5 + dx * 0.5, b.y + b.h + dy * 0.5 - wh / 2, 10, wh);
      }
      // восточный торец
      ctx.fillStyle = shade(b.c, 0.7);
      ctx.beginPath();
      ctx.moveTo(b.x + b.w, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x + b.w + dx, b.y + b.h + dy);
      ctx.lineTo(b.x + b.w + dx, b.y + dy);
      ctx.closePath();
      ctx.fill();
      // крыша
      ctx.fillStyle = b.c;
      ctx.fillRect(b.x + dx, b.y + dy, b.w, b.h);
      ctx.strokeStyle = shade(b.c, 1.25);
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x + dx + 5, b.y + dy + 5, b.w - 10, b.h - 10);
      ctx.fillStyle = shade(b.c, 0.76);
      for (const [vx, vy, vs] of b.vents) ctx.fillRect(b.x + dx + vx, b.y + dy + vy, vs, vs);
      ctx.fillStyle = "rgba(255,214,140,0.3)";
      ctx.fillRect(b.x + dx + b.w * 0.12, b.y + dy + b.h * 0.12, 24, 24);
    }
  }

  private drawLamps(vis: Rect): void {
    const { ctx } = this;
    for (const l of this.city.lamps) {
      if (l.x < vis.x - 30 || l.x > vis.x + vis.w + 30 || l.y < vis.y - 30 || l.y > vis.y + vis.h + 30) continue;
      ctx.fillStyle = "#10151f";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#39435a";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCar(): void {
    const { ctx } = this;
    const c = this.car;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle + c.steer * 0.05);
    ctx.fillStyle = "rgba(5,8,16,0.42)";
    ctx.beginPath();
    ctx.ellipse(2, 6, 24, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e5472f";
    ctx.beginPath();
    ctx.roundRect(-20, -11, 40, 22, 8);
    ctx.fill();
    ctx.fillStyle = "#f0593a";
    ctx.beginPath();
    ctx.roundRect(8, -9, 10, 18, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255,244,230,0.8)";
    ctx.fillRect(-20, -2, 40, 4);
    ctx.fillStyle = "#152233";
    ctx.beginPath();
    ctx.roundRect(0, -8, 7, 16, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(-13, -7.5, 5, 15, 2.5);
    ctx.fill();
    ctx.fillStyle = "#c23a25";
    ctx.beginPath();
    ctx.roundRect(-8, -9, 9, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#ffe9b0";
    ctx.fillRect(17.5, -9, 3.5, 5);
    ctx.fillRect(17.5, 4, 3.5, 5);
    ctx.fillStyle = this.braking ? "#ff5340" : "#8c2318";
    ctx.fillRect(-21.5, -9, 3, 5);
    ctx.fillRect(-21.5, 4, 3, 5);
    ctx.restore();
  }

  private drawParticles(mode: "smoke" | "solid"): void {
    const { ctx } = this;
    for (const p of this.particles) {
      const isSmoke = p.kind === "smoke";
      if ((mode === "smoke") !== isSmoke) continue;
      const k = p.life / p.max;
      if (p.kind === "smoke") {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = k * 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === "spark" || p.kind === "leaf") {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = p.color;
        ctx.globalAlpha = k;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, k * 1.6);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  }

  private lightPass(vis: Rect): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "rgba(9,13,32,0.47)";
    ctx.fillRect(vis.x, vis.y, vis.w, vis.h);
    ctx.globalCompositeOperation = "lighter";

    // фонари
    for (const l of this.city.lamps) {
      if (l.x < vis.x - 170 || l.x > vis.x + vis.w + 170 || l.y < vis.y - 170 || l.y > vis.y + vis.h + 170) continue;
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, 150);
      g.addColorStop(0, "rgba(255,199,124,0.19)");
      g.addColorStop(1, "rgba(255,199,124,0)");
      ctx.fillStyle = g;
      ctx.fillRect(l.x - 150, l.y - 150, 300, 300);
      ctx.fillStyle = "rgba(255,226,170,0.85)";
      ctx.beginPath();
      ctx.arc(l.x, l.y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // свечение билбордов
    this.city.billboards.forEach((b, idx) => {
      if (!inView(b, vis, 160)) return;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2 - 22;
      if (!b.discovered) {
        const pulse = 0.5 + 0.5 * Math.sin(this.wall * 3 + idx * 1.7);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 130);
        g.addColorStop(0, `rgba(255,183,84,${0.05 + 0.1 * pulse})`);
        g.addColorStop(1, "rgba(255,183,84,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 130, cy - 130, 260, 260);
      } else {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120);
        g.addColorStop(0, rgba(b.client.color, 0.13));
        g.addColorStop(1, rgba(b.client.color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - 120, cy - 120, 240, 240);
      }
    });

    // свет над работающими заправками
    for (const s of this.city.stations) {
      if (s.state !== "active") continue;
      if (!inView(s, vis, 230)) continue;
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 190);
      g.addColorStop(0, "rgba(255,205,130,0.2)");
      g.addColorStop(1, "rgba(255,205,130,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - 190, cy - 190, 380, 380);
    }

    // фары
    const c = this.car;
    const hx = Math.cos(c.angle);
    const hy = Math.sin(c.angle);
    const px = -hy;
    const py = hx;
    for (const s of [-7, 7]) {
      const ox = c.x + hx * 19 + px * s;
      const oy = c.y + hy * 19 + py * s;
      const fx = c.x + hx * 235;
      const fy = c.y + hy * 235;
      const g = ctx.createLinearGradient(ox, oy, fx, fy);
      g.addColorStop(0, "rgba(255,224,158,0.3)");
      g.addColorStop(1, "rgba(255,224,158,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(fx + px * 46, fy + py * 46);
      ctx.lineTo(fx - px * 46, fy - py * 46);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,236,190,0.5)";
      ctx.beginPath();
      ctx.arc(ox, oy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // стоп-сигналы
    if (this.braking) {
      for (const s of [-7, 7]) {
        const ox = c.x - hx * 21 + px * s;
        const oy = c.y - hy * 21 + py * s;
        const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 30);
        g.addColorStop(0, "rgba(255,64,48,0.4)");
        g.addColorStop(1, "rgba(255,64,48,0)");
        ctx.fillStyle = g;
        ctx.fillRect(ox - 30, oy - 30, 60, 60);
      }
    }
    ctx.restore();
  }

  /* ---------------- minimap ---------------- */

  private paintMinimapBase(): void {
    const m = this.mmBase.getContext("2d");
    if (!m) return;
    const s = MM / WORLD;
    m.fillStyle = "#0f1624";
    m.fillRect(0, 0, MM, MM);
    m.fillStyle = "#1d2738";
    for (const b of this.city.blocks) m.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
    m.fillStyle = "#24402e";
    for (const p of this.city.parks) m.fillRect(p.x * s, p.y * s, p.w * s, p.h * s);
    // АЗС рисуются динамически (состояния меняются по ходу игры)
    m.fillStyle = "#3d4b64";
    for (const c of this.city.roadCenters) {
      m.fillRect((c - ROAD / 2) * s, 0, ROAD * s, MM);
      m.fillRect(0, (c - ROAD / 2) * s, MM, ROAD * s);
    }
  }

  private drawMinimap(): void {
    if (!this.mctx || !this.mini) return;
    const m = this.mctx;
    const s = MM / WORLD;
    m.clearRect(0, 0, MM, MM);
    m.drawImage(this.mmBase, 0, 0);
    // АЗС: активные — пульсирующий оранжевый, «пустые» — серые с красной точкой
    const carMX = this.car.x * s;
    const carMY = this.car.y * s;
    for (const st of this.city.stations) {
      const sx = st.x * s - 1;
      const sy = st.y * s - 1;
      const sw = st.w * s + 2;
      const sh = st.h * s + 2;
      const mx = sx + sw / 2;
      const my = sy + sh / 2;
      if (st.state === "active") {
        const pulse = 0.55 + 0.45 * Math.sin(this.wall * 3 + st.x * 0.01);
        m.fillStyle = "#f2a93b";
        m.fillRect(sx, sy, sw, sh);
        m.strokeStyle = `rgba(255,224,160,${pulse * 0.9})`;
        m.lineWidth = 1;
        m.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
        // стрелка от машины к станции + дистанция
        const dx = mx - carMX;
        const dy = my - carMY;
        const dpx = Math.hypot(dx, dy);
        if (dpx > 22) {
          const ux = dx / dpx;
          const uy = dy / dpx;
          const x1 = carMX + ux * 9;
          const y1 = carMY + uy * 9;
          const x2 = mx - ux * 9;
          const y2 = my - uy * 9;
          m.strokeStyle = "rgba(242,169,59,0.85)";
          m.lineWidth = 1.6;
          m.beginPath();
          m.moveTo(x1, y1);
          m.lineTo(x2, y2);
          m.stroke();
          const ang = Math.atan2(y2 - y1, x2 - x1);
          m.fillStyle = "rgba(255,209,122,0.95)";
          m.beginPath();
          m.moveTo(x2 + Math.cos(ang) * 4.6, y2 + Math.sin(ang) * 4.6);
          m.lineTo(x2 + Math.cos(ang + 2.5) * 4.4, y2 + Math.sin(ang + 2.5) * 4.4);
          m.lineTo(x2 + Math.cos(ang - 2.5) * 4.4, y2 + Math.sin(ang - 2.5) * 4.4);
          m.closePath();
          m.fill();
          // подпись с дистанцией
          const meters = (dpx / s) * M_PER_PX;
          const label =
            meters >= 1000
              ? `${(meters / 1000).toFixed(1).replace(".", ",")} км`
              : `${Math.round(meters / 10) * 10} м`;
          const lx = (x1 + x2) / 2;
          const ly = (y1 + y2) / 2;
          m.font = "700 9px Rubik";
          m.textAlign = "center";
          m.textBaseline = "middle";
          const tw = m.measureText(label).width;
          m.fillStyle = "rgba(8,12,22,0.85)";
          m.fillRect(lx - tw / 2 - 3, ly - 6.5, tw + 6, 13);
          m.fillStyle = "#ffd9a0";
          m.fillText(label, lx, ly + 0.5);
          m.textAlign = "left";
          m.textBaseline = "alphabetic";
        }
      } else {
        m.fillStyle = "#333b49";
        m.fillRect(sx, sy, sw, sh);
        m.fillStyle = "#a34a3e";
        m.fillRect(sx + sw / 2 - 1, sy + sh / 2 - 1, 2, 2);
      }
    }
    this.city.billboards.forEach((b, i) => {
      const bx = (b.x + b.w / 2) * s;
      const by = (b.y + b.h / 2) * s;
      if (b.discovered) {
        m.fillStyle = "#5d6880";
        m.fillRect(bx - 2, by - 2, 4, 4);
      } else {
        const pulse = 0.55 + 0.45 * Math.sin(this.wall * 3 + i * 1.7);
        m.fillStyle = `rgba(255,183,84,${pulse})`;
        m.beginPath();
        m.arc(bx, by, 3.4, 0, Math.PI * 2);
        m.fill();
      }
    });
    // машина
    const cx = this.car.x * s;
    const cy = this.car.y * s;
    m.save();
    m.translate(cx, cy);
    m.rotate(this.car.angle);
    m.fillStyle = "rgba(255,120,90,0.35)";
    m.beginPath();
    m.arc(0, 0, 7, 0, Math.PI * 2);
    m.fill();
    m.fillStyle = "#fdf3e3";
    m.beginPath();
    m.moveTo(6.5, 0);
    m.lineTo(-4.5, 4.5);
    m.lineTo(-4.5, -4.5);
    m.closePath();
    m.fill();
    m.restore();
  }
}

export type { Lamp, Tree };

import { ROAD, WORLD, CANISTER_R } from "./world";
import type { Canister, City, Station } from "./world";
import { ACC, BRAKE, MAX_SPEED, grip } from "./car";

/* Боты-конкуренты: катаются по решётке улиц, забирают канистры и заправляются.
   Алгоритм каждого выбирается случайно и равновероятно из двух:
   1) "station" — еду к ближайшей активной АЗС, по пути подбираю канистру;
   2) "canister" — еду к ближайшей канистре, потом к ближайшей активной АЗС,
      но если по пути к канистре попалась активная АЗС — заправляюсь на ней.
   Поверх плана бот иногда бросает дела и идёт на таран машины игрока. */

export const BOT_COLORS = [
  "#3f8cff",
  "#f2a93b",
  "#8b5cf6",
  "#22c3a6",
  "#ff7ab8",
  "#c9d64b",
  "#ff8b3d",
  "#4dd2ff",
  "#b07d4f",
  "#9aa7bd",
];

// в нике всегда два «_» — по ним бота видно с первого взгляда
export const BOT_NAMES = [
  "__Вихрь",
  "__Полночь",
  "__Форсаж",
  "__Клаксон",
  "__Дизель",
  "__Гроза",
  "__Фара",
  "__Турбина",
  "__Шумахер",
  "__Ночник",
];

export type BotPlan = "station" | "canister";

type Goal =
  | { kind: "station"; x: number; y: number; st: Station }
  | { kind: "canister"; x: number; y: number; k: Canister }
  | { kind: "base"; x: number; y: number }
  | { kind: "player"; x: number; y: number }
  | { kind: "wander"; x: number; y: number };

export interface Bot {
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  name: string;
  plan: BotPlan;
  goal: Goal | null;
  gotCanister: boolean; // пункт «взять канистру» выполнен
  refuelled: boolean; // пункт «заправиться» выполнен
  wait: number; // стоим под колонкой, с
  at: Station | null; // под какой колонкой стоим
  think: number; // до пересчёта цели, с
  taken: number; // сколько канистр забрал за заезд
  kx: number; // скорость отлёта после тарана
  ky: number;
  stun: number; // пока > 0 — руль и газ не работают, машину несёт
  // манера езды: у каждого своя, иначе колонна едет как по линейке
  style: number; // насколько уверенно жмёт газ, 0.82..1
  lane: number; // смещение от оси улицы — своя полоса
  wob: number; // фаза покачивания руля
  lazy: number; // секунды «скинул газ»
  lazyCd: number; // до следующего такого зевка
  aggro: number; // секунды охоты за игроком
  aggroCd: number; // пауза между охотами
}

/** что бот сделал на этом кадре — движку нужно для эффектов и экономики АЗС */
export interface BotStep {
  took: { x: number; y: number } | null; // где подобрал канистру
  refuelAt: Station | null; // на какой АЗС бот только что встал под колонку
  soldAt: { x: number; y: number } | null; // где сдал канистры на базе
}

const BOT_R = 15; // радиус кузова
const LANE_EPS = 60; // насколько близко к оси улицы считается «еду по ней»
const FINAL_DIST = 190; // с этого расстояния к цели едем напрямую
const DETOUR = 260; // цель считается «по пути», если она не дальше этого от маршрута
const REFUEL_S = 2.4; // сколько бот стоит под колонкой
const SELL_S = 2; // сколько бот стоит на базе, пока сливает бензин
const SELL_FROM = 2; // с этого количества канистр бот едет продавать
const THINK_S = 0.25; // как часто пересчитывать цель
const AGGRO_RANGE = 1300; // с какого расстояния бот может решиться на таран
const AGGRO_CHANCE = 0.14; // вероятность в секунду, пока игрок в радиусе
const AGGRO_PAUSE = 14; // сколько ждать до следующей охоты

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function nearestLane(city: City, v: number): number {
  let best = city.roadCenters[0];
  for (const c of city.roadCenters) if (Math.abs(c - v) < Math.abs(best - v)) best = c;
  return best;
}

/** расстояние от точки до отрезка — им проверяем «по пути или нет» */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const stationGoal = (st: Station): Goal => ({
  kind: "station",
  x: st.x + st.w / 2,
  y: st.y + st.h / 2,
  st,
});
const canisterGoal = (k: Canister): Goal => ({ kind: "canister", x: k.x, y: k.y, k });

function activeStations(city: City): Station[] {
  return city.stations.filter((s) => s.state === "active");
}
function freeCanisters(city: City): Canister[] {
  return city.canisters.filter((k) => !k.taken);
}
function nearestOf<T extends { x: number; y: number }>(b: Bot, list: T[]): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const it of list) {
    const d = Math.hypot(it.x - b.x, it.y - b.y);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
}

function rollPlan(b: Bot): void {
  b.plan = Math.random() < 0.5 ? "station" : "canister"; // равновероятно
  b.gotCanister = false;
  b.refuelled = false;
  b.goal = null;
  b.think = 0;
}

function wanderGoal(city: City): Goal {
  const rc = city.roadCenters;
  return {
    kind: "wander",
    x: rc[Math.floor(Math.random() * rc.length)],
    y: rc[Math.floor(Math.random() * rc.length)],
  };
}

function chooseGoal(b: Bot, city: City): Goal {
  const stations = activeStations(city);
  const cans = freeCanisters(city);

  // больше одной полной канистры на борту — везём их на базу нелегальной скупки
  if (b.taken >= SELL_FROM) {
    return { kind: "base", x: city.base.x + city.base.w / 2, y: city.base.y + city.base.h / 2 };
  }

  if (b.plan === "station" || b.gotCanister) {
    // основная цель — ближайшая работающая АЗС
    const st = nearestOf(b, stations.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s })));
    if (!st) {
      const k = nearestOf(b, cans);
      return k ? canisterGoal(k) : wanderGoal(city);
    }
    if (b.plan === "station") {
      // канистра по пути — заворачиваем за ней
      const onWay = cans
        .filter((k) => distToSegment(k.x, k.y, b.x, b.y, st.x, st.y) < DETOUR)
        .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y))[0];
      if (onWay) return canisterGoal(onWay);
    }
    return stationGoal(st.st);
  }

  // алгоритм 2: сначала ближайшая канистра
  const k = nearestOf(b, cans);
  if (!k) {
    const st = nearestOf(b, stations.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s })));
    return st ? stationGoal(st.st) : wanderGoal(city);
  }
  if (!b.refuelled) {
    // активная АЗС по пути к канистре — заправляемся на ней
    const onWay = stations
      .map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s }))
      .filter((s) => distToSegment(s.x, s.y, b.x, b.y, k.x, k.y) < DETOUR)
      .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y))[0];
    if (onWay) return stationGoal(onWay.st);
  }
  return canisterGoal(k);
}

function goalStale(g: Goal): boolean {
  if (g.kind === "canister") return g.k.taken;
  if (g.kind === "station") return g.st.state !== "active";
  return false;
}

/** следующая точка маршрута: едем по осям улиц, поворачивая на перекрёстках */
function waypoint(b: Bot, city: City, gx: number, gy: number): { x: number; y: number } {
  if (Math.hypot(gx - b.x, gy - b.y) < FINAL_DIST) return { x: gx, y: gy };
  const colX = nearestLane(city, gx);
  const rowY = nearestLane(city, gy);
  if (Math.abs(b.x - colX) < LANE_EPS) return { x: colX, y: gy }; // уже на нужной вертикали
  if (Math.abs(b.y - rowY) < LANE_EPS) return { x: gx, y: rowY }; // уже на нужной горизонтали

  const myCol = nearestLane(city, b.x);
  const myRow = nearestLane(city, b.y);
  const onCol = Math.abs(b.x - myCol) < LANE_EPS;
  const onRow = Math.abs(b.y - myRow) < LANE_EPS;
  if (onCol && onRow) {
    // на перекрёстке — сначала закрываем ту ось, где разрыв больше
    return Math.abs(gx - b.x) > Math.abs(gy - b.y) ? { x: colX, y: myRow } : { x: myCol, y: rowY };
  }
  if (onRow) return { x: colX, y: myRow }; // по своей улице до нужной вертикали
  if (onCol) return { x: myCol, y: rowY }; // по своей улице до нужной горизонтали
  // сбились с решётки (например, выехали с площадки АЗС) — возвращаемся на ближайшую ось
  return Math.abs(b.x - myCol) < Math.abs(b.y - myRow) ? { x: myCol, y: b.y } : { x: b.x, y: myRow };
}

/** отлёт после тарана: гасим импульс и двигаем машину независимо от руля */
function applyKnock(b: Bot, dt: number): void {
  if (b.kx === 0 && b.ky === 0) return;
  b.x = clamp(b.x + b.kx * dt, 30, WORLD - 30);
  b.y = clamp(b.y + b.ky * dt, 30, WORLD - 30);
  const decay = Math.exp(-3.4 * dt);
  b.kx *= decay;
  b.ky *= decay;
  if (Math.hypot(b.kx, b.ky) < 4) {
    b.kx = 0;
    b.ky = 0;
  }
}

/**
 * Езда «как человек»: целимся не в саму точку маршрута, а в свою полосу рядом с
 * ней, слегка водим рулём, разгоняемся до потолка игрока и тормозим перед
 * поворотами. Поворотливость и разгон — те же, что у машины игрока.
 */
function drive(b: Bot, wx: number, wy: number, dt: number): void {
  const dx = wx - b.x;
  const dy = wy - b.y;
  const len = Math.hypot(dx, dy) || 1;
  // прицел сдвинут вбок: своя полоса плюс лёгкое покачивание
  const px = -dy / len;
  const py = dx / len;
  const off = b.lane + Math.sin(b.wob) * 7;
  const want = Math.atan2(wy + py * off - b.y, wx + px * off - b.x);

  let d = want - b.angle;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const maxTurn = 3.1 * Math.max(grip(b.speed), 0.32);
  b.angle += Math.sign(d) * Math.min(Math.abs(d), maxTurn * dt);

  const ad = Math.abs(d);
  let target = MAX_SPEED * b.style;
  target = Math.min(target, len * 2.4 + 120); // в поворот входим не на полном газу
  if (ad > 0.8) target = Math.min(target, MAX_SPEED * 0.26);
  else if (ad > 0.35) target = Math.min(target, MAX_SPEED * 0.55);
  if (b.lazy > 0) target *= 0.55; // зевок: скинул газ и катится
  b.speed = b.speed < target ? Math.min(target, b.speed + ACC * dt) : Math.max(target, b.speed - BRAKE * dt);

  b.x = clamp(b.x + Math.cos(b.angle) * b.speed * dt, 30, WORLD - 30);
  b.y = clamp(b.y + Math.sin(b.angle) * b.speed * dt, 30, WORLD - 30);
}

/** мелкая живость: покачивание руля, случайные зевки, решение пойти на таран */
function updateMood(b: Bot, dt: number, player: { x: number; y: number }): void {
  b.wob += dt * (0.7 + b.style);
  if (b.lazy > 0) b.lazy -= dt;
  else {
    b.lazyCd -= dt;
    if (b.lazyCd <= 0) {
      b.lazy = Math.random() < 0.45 ? 0.35 + Math.random() * 1.1 : 0;
      b.lazyCd = 2.5 + Math.random() * 4.5;
    }
  }

  if (b.aggro > 0) {
    b.aggro -= dt;
    if (b.aggro <= 0) b.aggroCd = AGGRO_PAUSE + Math.random() * 12;
    return;
  }
  b.aggroCd -= dt;
  if (b.aggroCd > 0) return;
  const d = Math.hypot(player.x - b.x, player.y - b.y);
  if (d < AGGRO_RANGE && Math.random() < AGGRO_CHANCE * dt) {
    b.aggro = 3.5 + Math.random() * 3.5; // столько секунд будет висеть на хвосте
    b.goal = null;
    b.think = 0;
  }
}

export function createBots(city: City, count: number, start: { x: number; y: number }): Bot[] {
  const bots: Bot[] = [];
  for (let i = 0; i < count; i++) {
    let x = start.x;
    let y = start.y;
    let vertical = true;
    for (let tries = 0; tries < 120; tries++) {
      vertical = Math.random() < 0.5;
      const lane = city.roadCenters[Math.floor(Math.random() * city.roadCenters.length)];
      const along = ROAD + Math.random() * (WORLD - ROAD * 2);
      x = vertical ? lane : along;
      y = vertical ? along : lane;
      const farFromPlayer = Math.hypot(x - start.x, y - start.y) > 700;
      const farFromBots = bots.every((o) => Math.hypot(o.x - x, o.y - y) > 320);
      if (farFromPlayer && farFromBots) break;
    }
    const bot: Bot = {
      x,
      y,
      angle: vertical ? (Math.random() < 0.5 ? -Math.PI / 2 : Math.PI / 2) : Math.random() < 0.5 ? 0 : Math.PI,
      speed: 0,
      color: BOT_COLORS[i % BOT_COLORS.length],
      name: BOT_NAMES[i % BOT_NAMES.length],
      plan: "station",
      goal: null,
      gotCanister: false,
      refuelled: false,
      wait: 0,
      at: null,
      think: 0,
      taken: 0,
      kx: 0,
      ky: 0,
      stun: 0,
      style: 0.82 + Math.random() * 0.18,
      lane: (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 26),
      wob: Math.random() * Math.PI * 2,
      lazy: 0,
      lazyCd: Math.random() * 4,
      aggro: 0,
      aggroCd: 4 + Math.random() * 14,
    };
    rollPlan(bot);
    bots.push(bot);
  }
  return bots;
}

export function stepBot(b: Bot, city: City, dt: number, player: { x: number; y: number }): BotStep {
  const step: BotStep = { took: null, refuelAt: null, soldAt: null };
  applyKnock(b, dt);
  if (b.stun > 0) {
    // получил в бок — пару мгновений машину просто несёт
    b.stun -= dt;
    b.speed *= Math.max(0, 1 - 4 * dt);
    b.think = 0;
    return step;
  }
  if (b.wait > 0) {
    // стоим под колонкой
    b.wait -= dt;
    b.speed *= Math.max(0, 1 - 6 * dt);
    if (b.wait <= 0) b.at = null;
    return step;
  }

  updateMood(b, dt, player);

  if (b.aggro > 0) {
    // охота: цель — машина игрока, она движется, поэтому обновляем каждый кадр
    b.goal = { kind: "player", x: player.x, y: player.y };
  } else {
    b.think -= dt;
    if (!b.goal || b.goal.kind === "player" || b.think <= 0 || goalStale(b.goal)) {
      b.goal = chooseGoal(b, city);
      b.think = THINK_S * (0.7 + Math.random() * 0.6);
    }
  }
  const g = b.goal;
  const wp = waypoint(b, city, g.x, g.y);
  drive(b, wp.x, wp.y, dt);

  // канистру подбираем любую, на которую наехали, — она и есть «по пути»
  const rr = (BOT_R + CANISTER_R) * (BOT_R + CANISTER_R);
  for (const k of city.canisters) {
    if (k.taken || k.cool > 0) continue;
    const dx = b.x - k.x;
    const dy = b.y - k.y;
    if (dx * dx + dy * dy > rr) continue;
    k.taken = true;
    b.gotCanister = true;
    b.taken += 1;
    b.think = 0;
    step.took = { x: k.x, y: k.y };
  }

  if (g.kind === "base") {
    const bs = city.base;
    if (b.x > bs.x - 6 && b.x < bs.x + bs.w + 6 && b.y > bs.y - 6 && b.y < bs.y + bs.h + 6) {
      // сдал канистры — дальше по плану
      b.wait = SELL_S;
      b.taken = 0;
      b.gotCanister = false;
      b.goal = null;
      b.think = 0;
      step.soldAt = { x: b.x, y: b.y };
    }
  } else if (g.kind === "station") {
    const s = g.st;
    if (s.state === "active" && b.x > s.x - 6 && b.x < s.x + s.w + 6 && b.y > s.y - 6 && b.y < s.y + s.h + 6) {
      b.wait = REFUEL_S;
      b.at = s;
      b.refuelled = true;
      b.goal = null;
      b.think = 0;
      step.refuelAt = s;
    }
  } else if (g.kind === "wander" && Math.hypot(g.x - b.x, g.y - b.y) < 60) {
    b.goal = null;
    b.think = 0;
  }

  // план выполнен — берём новый, снова равновероятный
  if (b.refuelled && (b.plan === "station" || b.gotCanister)) rollPlan(b);
  return step;
}

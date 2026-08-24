import type { Client } from "./clients";

/* ------- константы мира (в пикселях мировых координат) ------- */
export const BLOCK = 860; // размер квартала
export const ROAD = 170; // ширина дороги
export const GRID = 5; // 5×5 кварталов
export const WORLD = GRID * BLOCK + (GRID + 1) * ROAD; // 5320
export const SIDEWALK = 26; // тротуар по краю квартала
const BUILD_INSET = 96; // здания не ближе этой границы (место под билборды)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Building extends Rect {
  c: string; // цвет крыши/стены
  hgt: number; // «высота» для псевдо-3D
  winMask: number; // биты — какие окна горят
  vents: Array<[number, number, number]>; // вентблоки на крыше (dx,dy,размер)
}

export interface Billboard extends Rect {
  client: Client;
  discovered: boolean;
  vertical: boolean;
}

export interface Tree {
  x: number;
  y: number;
  r: number;
}

export interface Lamp {
  x: number;
  y: number;
}

export interface Park extends Rect {
  pond: { x: number; y: number; r: number } | null;
}

export interface City {
  blocks: Rect[];
  parks: Park[];
  buildings: Building[];
  billboards: Billboard[];
  trees: Tree[];
  lamps: Lamp[];
  roadCenters: number[];
}

/* детерминированный ГПСЧ, чтобы город всегда был один и тот же */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALL_COLORS = [
  "#67584f",
  "#5a6673",
  "#6d6a54",
  "#5d6f60",
  "#705a63",
  "#605d70",
  "#6b6157",
  "#54616b",
  "#77624f",
  "#4f6b6b",
];

interface Candidate {
  x: number;
  y: number;
  vertical: boolean;
}

export function buildCity(clients: Client[]): City {
  const rng = mulberry32(20260214);

  const roadCenters: number[] = [];
  for (let i = 0; i <= GRID; i++) roadCenters.push(ROAD / 2 + i * (BLOCK + ROAD));

  const blocks: Rect[] = [];
  const parks: Park[] = [];
  const buildings: Building[] = [];
  const trees: Tree[] = [];

  for (let bx = 0; bx < GRID; bx++) {
    for (let by = 0; by < GRID; by++) {
      const x = ROAD + bx * (BLOCK + ROAD);
      const y = ROAD + by * (BLOCK + ROAD);
      blocks.push({ x, y, w: BLOCK, h: BLOCK });

      const isPark = rng() < 0.24;
      if (isPark) {
        const pond =
          rng() < 0.55
            ? {
                x: x + BLOCK * (0.32 + rng() * 0.36),
                y: y + BLOCK * (0.32 + rng() * 0.36),
                r: 70 + rng() * 55,
              }
            : null;
        parks.push({ x, y, w: BLOCK, h: BLOCK, pond });
        const n = 10 + Math.floor(rng() * 6);
        for (let i = 0; i < n; i++) {
          const tx = x + 60 + rng() * (BLOCK - 120);
          const ty = y + 60 + rng() * (BLOCK - 120);
          if (pond && Math.hypot(tx - pond.x, ty - pond.y) < pond.r + 34) continue;
          trees.push({ x: tx, y: ty, r: 16 + rng() * 15 });
        }
      } else {
        // 2×2 ячейки застройки внутри квартала
        const inner = BLOCK - BUILD_INSET * 2; // 668
        const gap = 24;
        const cell = (inner - gap) / 2; // 322
        for (let cx0 = 0; cx0 < 2; cx0++) {
          for (let cy0 = 0; cy0 < 2; cy0++) {
            if (rng() < 0.14) continue; // пустырь / парковка
            const pad = 10 + rng() * 26;
            const bw = cell - pad * 2;
            const bh = cell - pad * 2;
            const bxPos = x + BUILD_INSET + cx0 * (cell + gap) + pad;
            const byPos = y + BUILD_INSET + cy0 * (cell + gap) + pad;
            const hgt = 20 + rng() * 28;
            const winCount = 10;
            let mask = 0;
            for (let k = 0; k < winCount; k++) if (rng() < 0.62) mask |= 1 << k;
            const vents: Array<[number, number, number]> = [];
            const vn = 1 + Math.floor(rng() * 3);
            for (let v = 0; v < vn; v++) {
              vents.push([14 + rng() * (bw - 60), 14 + rng() * (bh - 60), 16 + rng() * 16]);
            }
            buildings.push({
              x: bxPos,
              y: byPos,
              w: bw,
              h: bh,
              c: WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)],
              hgt,
              winMask: mask,
              vents,
            });
            // пара деревьев во дворе
            if (rng() < 0.5) {
              trees.push({
                x: bxPos - 26 + rng() * 20,
                y: byPos + rng() * bh,
                r: 13 + rng() * 8,
              });
            }
          }
        }
      }
    }
  }

  /* фонари вдоль дорог, мимо перекрёстков */
  const lamps: Lamp[] = [];
  const nearCenter = (v: number) => roadCenters.some((c) => Math.abs(v - c) < ROAD);
  for (let i = 0; i <= GRID; i++) {
    const c = roadCenters[i];
    for (let s = ROAD; s < WORLD - ROAD; s += 520) {
      const side = (Math.floor(s / 520) + i) % 2 === 0 ? 1 : -1;
      if (!nearCenter(s)) lamps.push({ x: c + side * (ROAD / 2 - 15), y: s });
      if (!nearCenter(s + 260)) lamps.push({ x: s + 260 > 0 && s + 260 < WORLD ? s + 260 : s, y: c + side * (ROAD / 2 - 15) });
    }
  }

  /* кандидаты под билборды — середина каждой стороны квартала, на тротуаре */
  const candidates: Candidate[] = [];
  const BW = 132;
  const BH = 72;
  for (const b of blocks) {
    const jx = () => b.x + BLOCK * (0.3 + rng() * 0.4);
    const jy = () => b.y + BLOCK * (0.3 + rng() * 0.4);
    candidates.push({ x: jx() - BW / 2, y: b.y + 4, vertical: false }); // верхняя сторона
    candidates.push({ x: jx() - BW / 2, y: b.y + BLOCK - BH - 4, vertical: false }); // нижняя
    candidates.push({ x: b.x + 4, y: jy() - BH / 2, vertical: true }); // левая
    candidates.push({ x: b.x + BLOCK - BW - 4, y: jy() - BH / 2, vertical: true }); // правая (вертикальный щит)
  }
  // перемешать и отобрать с минимальной дистанцией
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const billboards: Billboard[] = [];
  const shuffledClients = [...clients];
  for (let i = shuffledClients.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledClients[i], shuffledClients[j]] = [shuffledClients[j], shuffledClients[i]];
  }
  const cxOf = (cd: Candidate) => (cd.vertical ? cd.x + BH / 2 : cd.x + BW / 2);
  const cyOf = (cd: Candidate) => (cd.vertical ? cd.y + BW / 2 : cd.y + BH / 2);
  for (const cd of candidates) {
    if (billboards.length >= shuffledClients.length) break;
    const ok = billboards.every(
      (b) =>
        Math.hypot(cxOf(cd) - (b.x + b.w / 2), cyOf(cd) - (b.y + b.h / 2)) > 780
    );
    if (!ok) continue;
    const client = shuffledClients[billboards.length];
    billboards.push(
      cd.vertical
        ? { x: cd.x, y: cd.y, w: BH, h: BW, client, discovered: false, vertical: true }
        : { x: cd.x, y: cd.y, w: BW, h: BH, client, discovered: false, vertical: false }
    );
  }

  return { blocks, parks, buildings, billboards, trees, lamps, roadCenters };
}

/* Базовые размеры и скоростные настройки машин. */

export { TopDownCarPhysics } from "./vendor/spacejack-car-physics.ts";

export const MAX_SPEED = 640; // потолок скорости, px/с
export const ACC = 540; // разгон, px/с²
export const BRAKE = 780; // торможение, px/с²
export const CAR_R = 15; // радиус кузова для столкновений со стенами
export const KMH = 0.28; // px/с → км/ч на спидометре

/** поворотливость падает со скоростью — на разгоне машину «несёт» */
export function grip(speed: number): number {
  const sp = Math.abs(speed);
  return Math.min(sp / 150, 1) * (1 - 0.42 * (sp / MAX_SPEED));
}

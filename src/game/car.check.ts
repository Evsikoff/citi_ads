import { TopDownCarPhysics } from "./vendor/spacejack-car-physics.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const STEP = 1 / 60;
const LIMITS = { maxForwardSpeed: 640, maxReverseSpeed: 215 };

const straight = new TopDownCarPhysics();
straight.reset(0, 0, 0);
for (let i = 0; i < 120; i++) {
  straight.step({ throttle: 1, brake: 0, steering: 0, handbrake: 0 }, STEP, LIMITS);
}
assert(straight.speed > 300, `машина разгоняется слишком медленно: ${straight.speed}`);
assert(straight.speed <= 641, `превышен предел скорости: ${straight.speed}`);
assert(Math.abs(straight.y) < 0.001, `машину ведёт вбок на прямой: y=${straight.y}`);

function cornering(handbrake: number) {
  const car = new TopDownCarPhysics();
  car.reset(0, 0, 0);
  for (let i = 0; i < 70; i++) {
    car.step({ throttle: 1, brake: 0, steering: 0, handbrake: 0 }, STEP, LIMITS);
  }
  let maxLateralSpeed = 0;
  let maxRearSlip = 0;
  for (let i = 0; i < 55; i++) {
    const telemetry = car.step(
      { throttle: 0.65, brake: 0, steering: 1, handbrake },
      STEP,
      LIMITS
    );
    maxLateralSpeed = Math.max(maxLateralSpeed, Math.abs(telemetry.lateralSpeed));
    maxRearSlip = Math.max(maxRearSlip, Math.abs(telemetry.rearSlipAngle));
  }
  return { car, maxLateralSpeed, maxRearSlip };
}

const regularCorner = cornering(0);
const handbrakeCorner = cornering(1);
assert(
  regularCorner.car.angle > 0.15,
  `машина не входит в правый поворот: angle=${regularCorner.car.angle}`
);
assert(
  handbrakeCorner.maxLateralSpeed > regularCorner.maxLateralSpeed * 1.8,
  "ручник не усиливает контролируемый боковой снос"
);
assert(
  handbrakeCorner.maxRearSlip > regularCorner.maxRearSlip * 1.8,
  "ручник не снижает сцепление задней оси"
);

const beforeImpact = handbrakeCorner.car.absoluteSpeed;
handbrakeCorner.car.scaleVelocity(0.4);
assert(
  Math.abs(handbrakeCorner.car.absoluteSpeed - beforeImpact * 0.4) < 0.001,
  "импульс столкновения неправильно гасит векторную скорость"
);

console.log(
  `OK: разгон ${straight.speed.toFixed(1)} px/s, обычный снос ${regularCorner.maxLateralSpeed.toFixed(1)} px/s, ` +
    `с ручником ${handbrakeCorner.maxLateralSpeed.toFixed(1)} px/s`
);

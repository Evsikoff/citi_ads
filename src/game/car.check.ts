import { TopDownCarPhysics } from "./vendor/spacejack-car-physics.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const STEP = 1 / 60;
const LIMITS = { maxForwardSpeed: 640, maxReverseSpeed: 215 };
const DRIVER_ASSIST = 0.86;

const straight = new TopDownCarPhysics();
straight.reset(0, 0, 0);
for (let i = 0; i < 120; i++) {
  straight.step({ throttle: 1, brake: 0, steering: 0, handbrake: 0 }, STEP, LIMITS);
}
assert(straight.speed > 300, `машина разгоняется слишком медленно: ${straight.speed}`);
assert(straight.speed <= 641, `превышен предел скорости: ${straight.speed}`);
assert(Math.abs(straight.y) < 0.001, `машину ведёт вбок на прямой: y=${straight.y}`);

function cornering(handbrake: number, driverAssist: number) {
  const car = new TopDownCarPhysics();
  car.reset(0, 0, 0);
  for (let i = 0; i < 70; i++) {
    car.step(
      { throttle: 1, brake: 0, steering: 0, handbrake: 0 },
      STEP,
      { ...LIMITS, driverAssist }
    );
  }
  let maxLateralSpeed = 0;
  let maxRearSlip = 0;
  let minThrottleScale = 1;
  let maxSteeringCorrection = 0;
  for (let i = 0; i < 55; i++) {
    const telemetry = car.step(
      { throttle: 0.65, brake: 0, steering: 1, handbrake },
      STEP,
      { ...LIMITS, driverAssist }
    );
    maxLateralSpeed = Math.max(maxLateralSpeed, Math.abs(telemetry.lateralSpeed));
    maxRearSlip = Math.max(maxRearSlip, Math.abs(telemetry.rearSlipAngle));
    minThrottleScale = Math.min(minThrottleScale, telemetry.throttleScale);
    maxSteeringCorrection = Math.max(
      maxSteeringCorrection,
      Math.abs(telemetry.assistedSteering - 1)
    );
  }
  return { car, maxLateralSpeed, maxRearSlip, minThrottleScale, maxSteeringCorrection };
}

const rawCorner = cornering(0, 0);
const regularCorner = cornering(0, DRIVER_ASSIST);
const handbrakeCorner = cornering(1, DRIVER_ASSIST);
assert(
  regularCorner.car.angle > 0.15,
  `машина не входит в правый поворот: angle=${regularCorner.car.angle}`
);
assert(
  regularCorner.maxLateralSpeed < rawCorner.maxLateralSpeed * 0.8,
  "помощник недостаточно стабилизирует обычный поворот"
);
assert(
  regularCorner.maxSteeringCorrection > 0.08,
  "автоконтрруление не вмешивается при боковом скольжении"
);
assert(
  regularCorner.minThrottleScale < 0.9,
  "тяга не уменьшается в быстром резком повороте"
);
assert(
  handbrakeCorner.maxLateralSpeed > regularCorner.maxLateralSpeed * 1.8,
  "ручник не усиливает контролируемый боковой снос"
);
assert(
  handbrakeCorner.maxRearSlip > regularCorner.maxRearSlip * 1.8,
  "ручник не снижает сцепление задней оси"
);
assert(
  handbrakeCorner.minThrottleScale > regularCorner.minThrottleScale,
  "ручник должен ослаблять помощь с тягой для сохранения дрифта"
);

function recoverAfterTurn(driverAssist: number) {
  const car = new TopDownCarPhysics();
  car.reset(0, 0, 0);
  for (let i = 0; i < 70; i++) {
    car.step(
      { throttle: 1, brake: 0, steering: 0, handbrake: 0 },
      STEP,
      { ...LIMITS, driverAssist }
    );
  }
  for (let i = 0; i < 35; i++) {
    car.step(
      { throttle: 0.65, brake: 0, steering: 1, handbrake: 0 },
      STEP,
      { ...LIMITS, driverAssist }
    );
  }
  for (let i = 0; i < 60; i++) {
    car.step(
      { throttle: 0.45, brake: 0, steering: 0, handbrake: 0 },
      STEP,
      { ...LIMITS, driverAssist }
    );
  }
  return Math.abs(car.lateralSpeed);
}

const rawRecoverySlip = recoverAfterTurn(0);
const assistedRecoverySlip = recoverAfterTurn(DRIVER_ASSIST);
assert(
  assistedRecoverySlip < rawRecoverySlip * 0.35,
  "после отпускания руля машина недостаточно быстро выравнивается"
);

const beforeImpact = handbrakeCorner.car.absoluteSpeed;
handbrakeCorner.car.scaleVelocity(0.4);
assert(
  Math.abs(handbrakeCorner.car.absoluteSpeed - beforeImpact * 0.4) < 0.001,
  "импульс столкновения неправильно гасит векторную скорость"
);

console.log(
  `OK: разгон ${straight.speed.toFixed(1)} px/s, снос без помощи ${rawCorner.maxLateralSpeed.toFixed(1)} px/s, ` +
    `с помощником ${regularCorner.maxLateralSpeed.toFixed(1)} px/s, с ручником ${handbrakeCorner.maxLateralSpeed.toFixed(1)} px/s`
);

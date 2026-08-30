/**
 * Self-contained TypeScript port of the MIT-licensed car model from
 * https://github.com/spacejack/carphysics2d (commit 1266b154fb79320db19d14874d6bdf0825687d44).
 *
 * The original JavaScript implementation is by Mike Linkovich and is based on
 * Marco Monster's "Car Physics for Games" model. See the adjacent license file.
 * This port keeps the two-axle slip-angle, weight-transfer and tire-force model,
 * while exposing game-pixel units and removing rendering/input dependencies.
 */

export interface TopDownCarInput {
  /** -1 — full reverse, 1 — full forward throttle. */
  throttle: number;
  brake: number;
  steering: number;
  handbrake: number;
}

export interface TopDownCarLimits {
  maxForwardSpeed: number;
  maxReverseSpeed: number;
  /** 0 — raw physics, 1 — full arcade steering and stability assistance. */
  driverAssist?: number;
  /** Tire grip multiplier for the current surface. */
  surfaceGrip?: number;
  /** Rolling and aerodynamic resistance multiplier for the current surface. */
  resistance?: number;
}

export interface TopDownCarTelemetry {
  forwardSpeed: number;
  lateralSpeed: number;
  absoluteSpeed: number;
  frontSlipAngle: number;
  rearSlipAngle: number;
  assistedSteering: number;
  throttleScale: number;
  slipping: boolean;
}

export interface TopDownCarConfig {
  pixelsPerMeter: number;
  gravity: number;
  mass: number;
  inertiaScale: number;
  cgToFrontAxle: number;
  cgToRearAxle: number;
  cgHeight: number;
  tireGrip: number;
  lockedRearGrip: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  weightTransfer: number;
  maxSteerAngle: number;
  steerRate: number;
  steerReturnRate: number;
  safeSteerReduction: number;
  counterSteerFromSlip: number;
  counterSteerFromYaw: number;
  maxCounterSteer: number;
  lateralStability: number;
  yawStability: number;
  turnThrottleReduction: number;
  slipThrottleReduction: number;
  cornerStiffnessFront: number;
  cornerStiffnessRear: number;
  airResistance: number;
  rollingResistance: number;
}

const DEFAULT_CONFIG: TopDownCarConfig = {
  pixelsPerMeter: 50,
  gravity: 9.81,
  mass: 1200,
  inertiaScale: 1,
  cgToFrontAxle: 1.25,
  cgToRearAxle: 1.25,
  cgHeight: 0.55,
  tireGrip: 1.85,
  lockedRearGrip: 0.22,
  engineForce: 13500,
  brakeForce: 9000,
  handbrakeForce: 4200,
  weightTransfer: 0.2,
  maxSteerAngle: 0.62,
  steerRate: 3.4,
  steerReturnRate: 4.5,
  safeSteerReduction: 0.58,
  counterSteerFromSlip: 0.68,
  counterSteerFromYaw: 0.1,
  maxCounterSteer: 0.42,
  lateralStability: 1.35,
  yawStability: 1.05,
  turnThrottleReduction: 0.24,
  slipThrottleReduction: 0.36,
  cornerStiffnessFront: 5,
  cornerStiffnessRear: 5.2,
  airResistance: 2.5,
  rollingResistance: 350,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const moveTowards = (value: number, target: number, amount: number): number =>
  value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);

const normalizeAngle = (angle: number): number => {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

/** Dynamic two-axle car model with lateral tire slip and weight transfer. */
export class TopDownCarPhysics {
  x = 0;
  y = 0;
  angle = 0;
  velocityX = 0;
  velocityY = 0;
  yawRate = 0;
  steer = 0;
  steerAngle = 0;

  private accelerationForward = 0;
  private readonly config: TopDownCarConfig;

  constructor(config: Partial<TopDownCarConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Signed velocity along the direction in which the body points, in px/s. */
  get speed(): number {
    return Math.cos(this.angle) * this.velocityX + Math.sin(this.angle) * this.velocityY;
  }

  set speed(value: number) {
    this.velocityX = Math.cos(this.angle) * value;
    this.velocityY = Math.sin(this.angle) * value;
    if (Math.abs(value) < 0.001) this.yawRate = 0;
  }

  get lateralSpeed(): number {
    return Math.cos(this.angle) * this.velocityY - Math.sin(this.angle) * this.velocityX;
  }

  get absoluteSpeed(): number {
    return Math.hypot(this.velocityX, this.velocityY);
  }

  reset(x: number, y: number, angle: number, speed = 0): void {
    this.x = x;
    this.y = y;
    this.angle = normalizeAngle(angle);
    this.velocityX = Math.cos(angle) * speed;
    this.velocityY = Math.sin(angle) * speed;
    this.yawRate = 0;
    this.steer = 0;
    this.steerAngle = 0;
    this.accelerationForward = 0;
  }

  /** Apply a network speed correction without deleting an existing drift. */
  addLongitudinalSpeed(delta: number): void {
    this.velocityX += Math.cos(this.angle) * delta;
    this.velocityY += Math.sin(this.angle) * delta;
  }

  scaleVelocity(factor: number, angularFactor = factor): void {
    this.velocityX *= factor;
    this.velocityY *= factor;
    this.yawRate *= angularFactor;
  }

  step(input: TopDownCarInput, dt: number, limits: TopDownCarLimits): TopDownCarTelemetry {
    const cfg = this.config;
    const step = clamp(dt, 0, 0.05);
    const pixelsPerMeter = cfg.pixelsPerMeter;
    if (step <= 0) return this.telemetry(0, 0);

    const maxForward = Math.max(1, limits.maxForwardSpeed);
    const maxReverse = Math.max(1, limits.maxReverseSpeed);
    const driverAssist = clamp(limits.driverAssist ?? 0, 0, 1);
    const surfaceGrip = clamp(limits.surfaceGrip ?? 1, 0.05, 2);
    const resistance = Math.max(0.05, limits.resistance ?? 1);
    const handbrake = clamp(input.handbrake, 0, 1);

    const sn = Math.sin(this.angle);
    const cs = Math.cos(this.angle);
    const forwardVelocity = (cs * this.velocityX + sn * this.velocityY) / pixelsPerMeter;
    const lateralVelocity = (cs * this.velocityY - sn * this.velocityX) / pixelsPerMeter;
    const speedRatio = clamp(this.absoluteSpeed / maxForward, 0, 1);
    const slipRatio = clamp(
      lateralVelocity / Math.max(Math.abs(forwardVelocity), 1.6),
      -1,
      1
    );

    const steeringInput = clamp(input.steering, -1, 1);
    // At useful road speeds the assistant gently counter-steers against the
    // body's sideways motion and excessive yaw. The handbrake mostly disables
    // it, so the player can still deliberately initiate and hold a drift.
    const assistStrength =
      driverAssist * clamp(this.absoluteSpeed / 180, 0, 1) * (1 - handbrake * 0.86);
    const counterSteer =
      clamp(
        slipRatio * cfg.counterSteerFromSlip - this.yawRate * cfg.counterSteerFromYaw,
        -cfg.maxCounterSteer,
        cfg.maxCounterSteer
      ) * assistStrength;
    const assistedSteering = clamp(steeringInput + counterSteer, -1, 1);
    const steerRate =
      Math.abs(assistedSteering) > 0.001 ? cfg.steerRate : cfg.steerReturnRate;
    this.steer = moveTowards(this.steer, assistedSteering, steerRate * step);

    const safeSteer = 1 - cfg.safeSteerReduction * speedRatio;
    this.steerAngle = this.steer * cfg.maxSteerAngle * safeSteer;

    const wheelBase = cfg.cgToFrontAxle + cfg.cgToRearAxle;
    const frontWeightRatio = cfg.cgToRearAxle / wheelBase;
    const rearWeightRatio = cfg.cgToFrontAxle / wheelBase;
    const axleWeightFront =
      cfg.mass *
      (frontWeightRatio * cfg.gravity -
        (cfg.weightTransfer * this.accelerationForward * cfg.cgHeight) / wheelBase);
    const axleWeightRear =
      cfg.mass *
      (rearWeightRatio * cfg.gravity +
        (cfg.weightTransfer * this.accelerationForward * cfg.cgHeight) / wheelBase);

    const yawSpeedFront = cfg.cgToFrontAxle * this.yawRate;
    const yawSpeedRear = -cfg.cgToRearAxle * this.yawRate;
    const stableForwardSpeed = Math.max(Math.abs(forwardVelocity), 0.35);
    const direction = Math.sign(forwardVelocity);
    const frontSlipAngle =
      Math.atan2(lateralVelocity + yawSpeedFront, stableForwardSpeed) -
      direction * this.steerAngle;
    const rearSlipAngle = Math.atan2(
      lateralVelocity + yawSpeedRear,
      stableForwardSpeed
    );

    const frontGrip = cfg.tireGrip * surfaceGrip;
    const rearGrip =
      frontGrip * (1 - handbrake * (1 - cfg.lockedRearGrip));
    const frictionFront =
      clamp(
        -cfg.cornerStiffnessFront * frontSlipAngle,
        -frontGrip,
        frontGrip
      ) * Math.max(0, axleWeightFront);
    const frictionRear =
      clamp(-cfg.cornerStiffnessRear * rearSlipAngle, -rearGrip, rearGrip) *
      Math.max(0, axleWeightRear);

    // Lifting the throttle a little in a fast, tight or already slipping turn
    // makes keyboard steering much less likely to turn into an unrecoverable spin.
    const requestedThrottle = clamp(input.throttle, -1, 1);
    const throttleScale =
      requestedThrottle > 0
        ? clamp(
            1 -
              assistStrength *
                (cfg.turnThrottleReduction * Math.abs(steeringInput) * speedRatio +
                  cfg.slipThrottleReduction * Math.abs(slipRatio)),
            0.58,
            1
          )
        : 1;
    const throttleForce = requestedThrottle * throttleScale * cfg.engineForce;
    const brakeForce = Math.min(
      clamp(input.brake, 0, 1) * cfg.brakeForce +
        handbrake * cfg.handbrakeForce,
      cfg.brakeForce
    );
    const brakingDirection = Math.abs(forwardVelocity) > 0.02 ? Math.sign(forwardVelocity) : 0;
    const tractionForward = throttleForce - brakeForce * brakingDirection;

    const dragForward =
      (-cfg.rollingResistance * forwardVelocity -
        cfg.airResistance * forwardVelocity * Math.abs(forwardVelocity)) *
      resistance;
    const dragLateral =
      (-cfg.rollingResistance * lateralVelocity -
        cfg.airResistance * lateralVelocity * Math.abs(lateralVelocity)) *
      resistance;

    const forceForward = dragForward + tractionForward;
    const forceLateral =
      dragLateral + Math.cos(this.steerAngle) * frictionFront + frictionRear;
    this.accelerationForward = forceForward / cfg.mass;
    const accelerationLateral = forceLateral / cfg.mass;

    const accelerationX = cs * this.accelerationForward - sn * accelerationLateral;
    const accelerationY = sn * this.accelerationForward + cs * accelerationLateral;
    this.velocityX += accelerationX * pixelsPerMeter * step;
    this.velocityY += accelerationY * pixelsPerMeter * step;

    let angularTorque =
      frictionFront * cfg.cgToFrontAxle - frictionRear * cfg.cgToRearAxle;
    if (this.absoluteSpeed < pixelsPerMeter * 0.1 && Math.abs(input.throttle) < 0.001) {
      this.velocityX = 0;
      this.velocityY = 0;
      this.yawRate = 0;
      angularTorque = 0;
    }

    const inertia = cfg.mass * cfg.inertiaScale;
    this.yawRate += (angularTorque / inertia) * step;
    this.yawRate = clamp(this.yawRate, -5.5, 5.5);

    // Stability control is strongest after the player releases steering, when
    // the desired action is normally to straighten the car. It nearly vanishes
    // with the handbrake held, preserving the original drift behaviour.
    const stabilityStrength =
      driverAssist * clamp(this.absoluteSpeed / 120, 0, 1) * (1 - handbrake * 0.92);
    const steeringDemand = Math.abs(steeringInput);
    const yawDamping =
      cfg.yawStability * stabilityStrength * (1 - steeringDemand * 0.4);
    this.yawRate *= Math.exp(-yawDamping * step);
    this.angle = normalizeAngle(this.angle + this.yawRate * step);

    const bodySn = Math.sin(this.angle);
    const bodyCs = Math.cos(this.angle);
    const bodyLateralSpeed = bodyCs * this.velocityY - bodySn * this.velocityX;
    const lateralDamping =
      cfg.lateralStability * stabilityStrength * (1 - steeringDemand * 0.45);
    const lateralCorrection = bodyLateralSpeed * (1 - Math.exp(-lateralDamping * step));
    this.velocityX += bodySn * lateralCorrection;
    this.velocityY -= bodyCs * lateralCorrection;

    this.limitVelocity(maxForward, maxReverse);
    this.x += this.velocityX * step;
    this.y += this.velocityY * step;

    return this.telemetry(frontSlipAngle, rearSlipAngle, assistedSteering, throttleScale);
  }

  private limitVelocity(maxForward: number, maxReverse: number): void {
    const forward = this.speed;
    if (forward > maxForward) this.scaleVelocity(maxForward / forward, 1);
    else if (forward < -maxReverse) this.scaleVelocity(maxReverse / -forward, 1);

    const absoluteLimit = maxForward * 1.12;
    const absolute = this.absoluteSpeed;
    if (absolute > absoluteLimit) this.scaleVelocity(absoluteLimit / absolute, 1);
  }

  private telemetry(
    frontSlipAngle: number,
    rearSlipAngle: number,
    assistedSteering = this.steer,
    throttleScale = 1
  ): TopDownCarTelemetry {
    const lateralSpeed = this.lateralSpeed;
    return {
      forwardSpeed: this.speed,
      lateralSpeed,
      absoluteSpeed: this.absoluteSpeed,
      frontSlipAngle,
      rearSlipAngle,
      assistedSteering,
      throttleScale,
      slipping:
        Math.abs(lateralSpeed) > 55 ||
        Math.abs(frontSlipAngle) > 0.18 ||
        Math.abs(rearSlipAngle) > 0.2,
    };
  }
}

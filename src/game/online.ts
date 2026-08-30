import type { City } from "./world";

export const GAME_SERVER_URL =
  "wss://ws--gdebenz-server--nz47zn545dwm.code.run/ws";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface ServerHello {
  protocolVersion: number;
  tickRate: number;
  snapshotRate: number;
}

export interface PublicPlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  fuel: number;
  tankVolume: number;
  money: number;
  canisters: number;
  filledLiters: number;
  status: "active" | "lost" | string;
  lastInputSeq: number;
  /** Накопленный сервером отскок после тарана, пикс/с. */
  kx?: number;
  ky?: number;
  /** Идёт заправка: машина стоит под колонкой. */
  refueling?: boolean;
  refuelStationId?: string | null;
  /** Литры и рубли текущей сессии заправки. */
  refuelLiters?: number;
  refuelSpent?: number;
  /** Множители от бустеров — их считает сервер. */
  speedMultiplier?: number;
  fuelConsumptionMultiplier?: number;
}

export interface RemoteEntityState {
  id: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  filledLiters: number;
  status?: string;
  canisters?: number;
  taken?: number;
  wait?: number;
  style?: number;
  lane?: number;
  wobble?: number;
  kx?: number;
  ky?: number;
  stun?: number;
}

export interface EntitySnapshot {
  tick: number;
  serverTime: number;
  worldRevision: number;
  players: PublicPlayerState[];
  bots: RemoteEntityState[];
}

/** Заправка началась или закончилась — сервер ведёт её сам. */
export interface RefuelEvent {
  playerId: string;
  stationId: string;
  state: "started" | "stopped";
  reason: "full" | "limit" | "money" | "left" | null;
  liters: number;
  spent: number;
}

/**
 * Столкновение двух машин, посчитанное сервером. Клиент по нему рисует искры,
 * трясёт камеру, даёт звук удара и сообщает о выбитых канистрах.
 */
export interface CollisionEvent {
  /** Точка касания кузовов в мировых координатах. */
  x: number;
  y: number;
  /** Сила удара — та же величина, что ушла в отскок. */
  force: number;
  /** Кто протаранил и кого: id игрока или бота. */
  rammerId: string;
  victimId: string;
  rammerIsPlayer: boolean;
  victimIsPlayer: boolean;
  /** Сколько канистр выбило из протаранённой машины. */
  spilled: number;
}

export interface ServerLeaderboardEntry {
  entityId: string;
  position: number;
  name: string;
  liters: number;
  isPlayer: boolean;
  color: string;
  active: boolean;
}

export interface ServerCity extends City {
  meta: {
    revision: number;
    seed: number;
    scale: number;
    grid: number;
    worldSize: number;
    blockSize: number;
    roadWidth: number;
  };
}

export interface WorldObjects {
  worldRevision: number;
  stations: ServerCity["stations"];
  billboards: ServerCity["billboards"];
  canisters: ServerCity["canisters"];
}

export interface InteractionResult {
  requestId: string;
  ok: boolean;
  code: string;
  player: PublicPlayerState;
  details?: Record<string, unknown>;
}

export interface GameEventResult extends InteractionResult {
  event:
    | "fuel-filled"
    | "station-blocked"
    | "billboard-interacted"
    | "player-lost"
    | "player-respawn"
    | "booster-applied"
    | string;
}

export interface ServerError {
  code: string;
  message: string;
  requestId?: string;
}

export interface PlayerControls {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  handbrake: boolean;
}

export type ObjectType = "billboard" | "station" | "canister" | "base";

export interface OnlineGameTransport {
  readonly connected: boolean;
  sendInput(input: PlayerControls): void;
  sendMove(position: Pick<PublicPlayerState, "x" | "y" | "angle" | "speed">): void;
  interact(objectType: ObjectType, objectId: string, amount?: number): string | null;
  fuelFilled(stationId: string, liters: number): string | null;
  stationBlocked(stationId: string): string | null;
  billboardInteracted(billboardId: string): string | null;
  playerLost(reason?: string): string | null;
  respawn(): string | null;
  booster(systemName: string, cost?: number): string | null;
}

export interface MultiplayerListeners {
  onStatus(status: ConnectionStatus): void;
  onHello?(hello: ServerHello): void;
  onWelcome?(playerId: string, player: PublicPlayerState): void;
  onSnapshot?(
    map: ServerCity,
    entities: EntitySnapshot,
    leaderboard: ServerLeaderboardEntry[]
  ): void;
  onEntities?(entities: EntitySnapshot): void;
  onCollisions?(collisions: CollisionEvent[]): void;
  onRefuel?(event: RefuelEvent): void;
  onObjects?(objects: WorldObjects): void;
  onMapUpdate?(map: ServerCity, reason: string, fuelBonus: number): void;
  onLeaderboard?(rows: ServerLeaderboardEntry[]): void;
  onInteractionResult?(result: InteractionResult): void;
  onGameEventResult?(result: GameEventResult): void;
  onPlayerRespawned?(player: PublicPlayerState): void;
  onPlayerDespawned?(playerId: string, reason?: string): void;
  onPlayerJoined?(player: PublicPlayerState): void;
  onPlayerLeft?(playerId: string): void;
  onError?(error: ServerError): void;
}

interface ServerEnvelope<T = unknown> {
  type: string;
  payload: T;
}

const requestId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Маленький транспортный слой протокола v1. Он ничего не знает о React и
 * canvas-движке: только держит WebSocket, нумерует команды и маршрутизирует
 * серверные события.
 */
export class MultiplayerClient implements OnlineGameTransport {
  private socket: WebSocket | null = null;
  private listeners: MultiplayerListeners;
  private hello: ServerHello | null = null;
  private inputSeq = 0;
  private moveSeq = 0;
  private worldRevision = 0;
  private gameReady = false;
  private pingTimer = 0;
  private disposed = false;
  private status: ConnectionStatus = "connecting";

  constructor(
    private readonly url: string,
    listeners: MultiplayerListeners
  ) {
    this.listeners = listeners;
  }

  get connected(): boolean {
    return this.status === "online" && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 5000): Promise<boolean> {
    this.disposed = false;
    this.setStatus("connecting");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(ok);
      };
      const fail = () => {
        if (this.status !== "online") {
          this.setStatus("offline");
          finish(false);
        }
      };
      const timeout = window.setTimeout(() => {
        fail();
        this.socket?.close(4000, "hello timeout");
      }, timeoutMs);

      try {
        const socket = new WebSocket(this.url);
        this.socket = socket;
        socket.addEventListener("message", (event) => {
          const message = this.parse(event.data);
          if (!message) return;
          if (message.type === "server:hello") {
            const hello = message.payload as ServerHello;
            if (hello.protocolVersion !== 1) {
              this.listeners.onError?.({
                code: "UNSUPPORTED_PROTOCOL",
                message: `Сервер использует протокол v${hello.protocolVersion}`,
              });
              socket.close(4001, "unsupported protocol");
              fail();
              return;
            }
            this.hello = hello;
            this.setStatus("online");
            this.listeners.onHello?.(hello);
            this.startPing();
            finish(true);
          }
          this.route(message);
        });
        socket.addEventListener("error", fail);
        socket.addEventListener("close", () => {
          this.stopPing();
          if (!this.disposed) this.setStatus("offline");
          finish(false);
        });
      } catch {
        fail();
      }
    });
  }

  join(name: string): void {
    this.inputSeq = 0;
    this.moveSeq = 0;
    this.worldRevision = 0;
    this.gameReady = false;
    this.send("player:join", { name });
  }

  sendInput(input: PlayerControls): void {
    if (!this.gameReady) return;
    this.send("player:input", {
      seq: this.inputSeq++,
      worldRevision: this.worldRevision,
      ...input,
    });
  }

  sendMove(position: Pick<PublicPlayerState, "x" | "y" | "angle" | "speed">): void {
    if (!this.gameReady) return;
    this.send("player:move", {
      seq: this.moveSeq++,
      worldRevision: this.worldRevision,
      ...position,
    });
  }

  interact(objectType: ObjectType, objectId: string, amount?: number): string | null {
    if (!this.gameReady) return null;
    const id = requestId();
    return this.send("world:interact", {
      requestId: id,
      objectType,
      objectId,
      ...(amount === undefined ? {} : { amount }),
    })
      ? id
      : null;
  }

  fuelFilled(stationId: string, liters: number): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:fuel-filled", { stationId, liters });
  }

  stationBlocked(stationId: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("station:blocked", { stationId });
  }

  billboardInteracted(billboardId: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("billboard:interacted", { billboardId });
  }

  playerLost(reason?: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:lost", reason ? { reason } : {});
  }

  booster(systemName: string, cost = 0): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:booster", { systemName, cost });
  }

  respawn(): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:respawn", {});
  }

  destroy(): void {
    this.disposed = true;
    this.stopPing();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, "client closed");
    }
    this.socket = null;
    this.gameReady = false;
  }

  private sendRequest(type: string, payload: Record<string, unknown>): string | null {
    const id = requestId();
    return this.send(type, { requestId: id, ...payload }) ? id : null;
  }

  private send(type: string, payload: Record<string, unknown>): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify({ type, payload }));
      return true;
    } catch {
      return false;
    }
  }

  private parse(data: unknown): ServerEnvelope | null {
    if (typeof data !== "string") return null;
    try {
      const message = JSON.parse(data) as Partial<ServerEnvelope>;
      return typeof message.type === "string" && "payload" in message
        ? (message as ServerEnvelope)
        : null;
    } catch {
      this.listeners.onError?.({ code: "BAD_SERVER_MESSAGE", message: "Сервер прислал некорректный JSON" });
      return null;
    }
  }

  private route(message: ServerEnvelope): void {
    switch (message.type) {
      case "server:hello":
      case "pong":
        return;
      case "player:welcome": {
        const payload = message.payload as { playerId: string; player: PublicPlayerState };
        this.listeners.onWelcome?.(payload.playerId, payload.player);
        return;
      }
      case "world:snapshot": {
        const payload = message.payload as {
          map: ServerCity;
          entities: EntitySnapshot;
          leaderboard: ServerLeaderboardEntry[];
        };
        this.worldRevision = payload.map.meta.revision;
        this.gameReady = true;
        this.listeners.onSnapshot?.(payload.map, payload.entities, payload.leaderboard);
        return;
      }
      case "world:entities": {
        const payload = message.payload as EntitySnapshot;
        this.worldRevision = payload.worldRevision;
        this.listeners.onEntities?.(payload);
        return;
      }
      case "player:refuel": {
        this.listeners.onRefuel?.(message.payload as RefuelEvent);
        return;
      }
      case "world:collisions": {
        const payload = message.payload as { tick: number; collisions: CollisionEvent[] };
        if (Array.isArray(payload.collisions) && payload.collisions.length > 0) {
          this.listeners.onCollisions?.(payload.collisions);
        }
        return;
      }
      case "world:objects": {
        const payload = message.payload as WorldObjects;
        this.worldRevision = payload.worldRevision;
        this.listeners.onObjects?.(payload);
        return;
      }
      case "world:map-update": {
        const payload = message.payload as {
          map: ServerCity;
          reason: string;
          fuelBonus: number;
          affectedPlayers: string[];
        };
        this.worldRevision = payload.map.meta.revision;
        this.listeners.onMapUpdate?.(payload.map, payload.reason, payload.fuelBonus);
        return;
      }
      case "leaderboard:update":
        this.listeners.onLeaderboard?.(
          (message.payload as { rows: ServerLeaderboardEntry[] }).rows
        );
        return;
      case "interaction:result":
        this.listeners.onInteractionResult?.(message.payload as InteractionResult);
        return;
      case "game:event-result":
        this.listeners.onGameEventResult?.(message.payload as GameEventResult);
        return;
      case "player:respawned":
        this.listeners.onPlayerRespawned?.(
          (message.payload as { player: PublicPlayerState }).player
        );
        return;
      case "player:despawned": {
        const payload = message.payload as { playerId: string; reason?: string };
        this.listeners.onPlayerDespawned?.(payload.playerId, payload.reason);
        return;
      }
      case "player:joined":
        this.listeners.onPlayerJoined?.(
          (message.payload as { player: PublicPlayerState }).player
        );
        return;
      case "player:left":
        this.listeners.onPlayerLeft?.((message.payload as { playerId: string }).playerId);
        return;
      case "server:error":
        this.listeners.onError?.(message.payload as ServerError);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && status !== "connecting") return;
    this.status = status;
    this.listeners.onStatus(status);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send("ping", { clientTime: Date.now() });
    }, 15000);
  }

  private stopPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }
}

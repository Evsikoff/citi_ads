import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CLIENTS } from "./game/clients";
import type { Client } from "./game/clients";
import { CityRideGame } from "./game/engine";
import type { HudData } from "./game/engine";
import { sfx } from "./game/audio";
import { CONFIG } from "./game/config";
import { ClientModal } from "./components/ClientModal";

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

/* ---------- мелкие SVG-иконки ---------- */
const BillBoardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
    <rect x="3" y="4" width="18" height="11" rx="1.5" stroke="currentColor" strokeWidth="2" />
    <path d="M12 15v5M8 20h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M7 8h6M7 11h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const SpeakerIcon = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    {muted ? (
      <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    ) : (
      <path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    )}
  </svg>
);
const FuelIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <path
      d="M5 21V6a2 2 0 012-2h5a2 2 0 012 2v15M4 21h11M14 10h2a2 2 0 012 2v5a1.5 1.5 0 003 0v-7.5L18.5 7M7 8h5v4H7z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CanisterIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "w-5 h-5"}>
    <path
      d="M6 7.5A1.5 1.5 0 017.5 6h9A1.5 1.5 0 0118 7.5v11A1.5 1.5 0 0116.5 20h-9A1.5 1.5 0 016 18.5v-11zM9 6V4.5h6V6M8.5 9.5l7 7"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const TrophyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-10 h-10 text-amber-glow">
    <path
      d="M7 4h10v5a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M12 14v3M8 20h8M9 17h6v3H9z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const GAUGE_TICKS = [0, 0.25, 0.5, 0.75, 1].map((f) => {
  const a = ((135 + 270 * f) * Math.PI) / 180;
  return { x: 60 + 52 * Math.cos(a), y: 60 + 52 * Math.sin(a) };
});

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<CityRideGame | null>(null);
  const speedTextRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const arcRef = useRef<SVGPathElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const fuelFillRef = useRef<HTMLDivElement>(null);
  const fuelTextRef = useRef<HTMLSpanElement>(null);
  const fuelIconRef = useRef<HTMLSpanElement>(null);
  const refuelRef = useRef<HTMLSpanElement>(null);
  const lowRef = useRef<HTMLSpanElement>(null);
  const stationsCountRef = useRef<HTMLSpanElement>(null);
  const refuelPanelRef = useRef<HTMLDivElement>(null);
  const refuelLitersRef = useRef<HTMLSpanElement>(null);
  const canisterCountRef = useRef<HTMLSpanElement>(null);
  const canisterHudRef = useRef<HTMLSpanElement>(null);
  const canisterHudCountRef = useRef<HTMLSpanElement>(null);
  const toastTimer = useRef<number>(0);

  const [phase, setPhase] = useState<"menu" | "play">("menu");
  const [modal, setModal] = useState<{ client: Client; index: number } | null>(null);
  const [foundIds, setFoundIds] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [win, setWin] = useState<{ time: number; top: number } | null>(null);
  const [gameover, setGameover] = useState<{ time: number; found: number } | null>(null);
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const [touch] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );

  const showToast = (msg: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), msg });
    toastTimer.current = window.setTimeout(() => setToast(null), 2300);
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (document.fonts) {
      document.fonts.load('16px "Russo One"').catch(() => {});
      document.fonts.load("600 12px Rubik").catch(() => {});
    }
    const game = new CityRideGame(cv, minimapRef.current, CLIENTS, {
      onHud: (h: HudData) => {
        if (speedTextRef.current) speedTextRef.current.textContent = String(h.speed);
        if (timerRef.current) timerRef.current.textContent = fmt(h.time);
        const pct = Math.min(h.speed / 180, 1);
        if (needleRef.current) needleRef.current.style.transform = `rotate(${pct * 270}deg)`;
        if (arcRef.current) arcRef.current.style.strokeDashoffset = String(100 - pct * 100);
        const f = h.fuel;
        const fm = h.fuelMax || 50;
        const fr = f / fm;
        if (fuelFillRef.current) {
          const fp = Math.max(0, Math.min(1, fr));
          fuelFillRef.current.style.width = `${fp * 100}%`;
          fuelFillRef.current.style.background = fr < 0.22 ? "#ff6b5a" : fr < 0.5 ? "#ffb454" : "#7ee08a";
        }
        if (fuelTextRef.current) fuelTextRef.current.textContent = `${Math.round(f)} л`;
        if (fuelIconRef.current) fuelIconRef.current.style.color = fr < 0.22 ? "#ff6b5a" : "#7ee08a";
        // индикатор переключаем через display: opacity перебивается анимацией anim-blink
        if (refuelRef.current) refuelRef.current.style.display = h.refueling ? "inline" : "none";
        if (refuelPanelRef.current) refuelPanelRef.current.style.display = h.refueling ? "flex" : "none";
        if (h.refueling) {
          if (refuelLitersRef.current) refuelLitersRef.current.textContent = `${Math.round(f)} / ${Math.round(fm)} л`;
          if (canisterCountRef.current) canisterCountRef.current.textContent = String(h.canisters);
        }
        if (canisterHudCountRef.current) canisterHudCountRef.current.textContent = String(h.canisters);
        if (canisterHudRef.current) canisterHudRef.current.style.opacity = h.canisters ? "1" : "0.45";
        if (lowRef.current) lowRef.current.style.display = !h.refueling && fr < 0.22 && f > 0 ? "inline" : "none";
        if (stationsCountRef.current) {
          const full = h.stationsActive >= h.stationsTotal;
          stationsCountRef.current.textContent = `${h.stationsActive}/${h.stationsTotal}`;
          stationsCountRef.current.style.color = full ? "#7ee08a" : "#f2a93b";
        }
      },
      onDiscover: (client, index) => {
        setFoundIds((prev) => (prev.includes(client.id) ? prev : [...prev, client.id]));
        setModal({ client, index });
      },
      onWin: (stats) => setWin(stats),
      onGameOver: (stats) => setGameover(stats),
      onBumpKnown: () => showToast("Этот клиент уже подписан — ищи свободный щит"),
      onStationUnlock: (active, total, origin) =>
        showToast(
          origin === "ad"
            ? `Реклама сработала: открылась ещё одна АЗС — теперь ${active} из ${total}`
            : `Подвезли топливо: новая АЗС в сети — ${active} из ${total}`
        ),
      onStationLock: (active, total) =>
        showToast(`Колонка занята — АЗС закрылась. Активных станций: ${active} из ${total}`),
      onCanister: (count, liters) =>
        showToast(`Канистра подобрана: бак вырос на ${liters} л (топливо не прибавилось). Канистр у тебя: ${count}`),
      onCanisterLost: (count, left) =>
        showToast(
          count > 1
            ? `Тебя протаранили — из багажника вылетело ${count} канистры. Осталось: ${left}`
            : `Тебя протаранили — канистра вылетела на дорогу. Осталось: ${left}`
        ),
    });
    gameRef.current = game;
    return () => {
      game.destroy();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    gameRef.current?.setPaused(!!modal);
  }, [modal]);

  const start = () => {
    sfx.init();
    sfx.tick();
    gameRef.current?.begin();
    setPhase("play");
  };

  const restart = () => {
    sfx.tick();
    gameRef.current?.reset();
    setFoundIds([]);
    setWin(null);
    setModal(null);
    setGameover(null);
    showToast("Новая смена: все билборды снова свободны, бак полный");
  };

  const toggleMute = () => {
    setMuted((m) => {
      sfx.setMuted(!m);
      return !m;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter") {
        if (phase === "menu") {
          e.preventDefault();
          start();
        } else if (gameover) {
          e.preventDefault();
          restart();
        }
      }
      if (e.code === "KeyM") toggleMute();
      if (e.code === "Escape") {
        if (modal) setModal(null);
        else if (win) setWin(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, modal, win, gameover]);

  const hold = (k: "up" | "down" | "left" | "right") => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      gameRef.current?.setKey(k, true);
    },
    onPointerUp: () => gameRef.current?.setKey(k, false),
    onPointerLeave: () => gameRef.current?.setKey(k, false),
    onPointerCancel: () => gameRef.current?.setKey(k, false),
  });

  const found = foundIds.length;

  return (
    <div className="fixed inset-0 overflow-hidden bg-night-900 no-select text-slate-200">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* ================= HUD ================= */}
      {phase === "play" && (
        <>
          {/* левый верх: счёт */}
          <div className="absolute top-4 left-4 z-10 pointer-events-none flex flex-col items-start gap-2">
            <div className="flex items-center gap-2 bg-night-900/85 border border-night-600 rounded-md px-3 py-2">
              <span className="text-amber-glow">
                <BillBoardIcon />
              </span>
              <span className="font-display text-sm tracking-wide text-[#f2ecdf]">Клиенты</span>
              <span className="font-display text-lg text-amber-glow leading-none">
                {found}
                <span className="text-slate-500 text-sm">/{CLIENTS.length}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 bg-night-900/85 border border-night-600 rounded-md px-3 py-1.5 text-xs text-slate-400">
              <svg viewBox="0 0 24 24" fill="none" className="w-3.5 h-3.5">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              в пути <span ref={timerRef} className="text-slate-200 font-semibold tabular-nums">0:00</span>
            </div>
          </div>

          {/* правый верх: портфель клиентов */}
          <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
            <div className="flex items-center gap-2 pointer-events-auto">
              <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500 font-semibold">
                Портфель клиентов
              </span>
              <button
                onClick={toggleMute}
                className="w-9 h-9 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow hover:border-night-600 transition-colors"
                aria-label="Звук"
              >
                <SpeakerIcon muted={muted} />
              </button>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5 max-w-[248px] pointer-events-none">
              {CLIENTS.map((cl) => {
                const got = foundIds.includes(cl.id);
                return (
                  <div
                    key={cl.id}
                    title={got ? cl.name : "Ещё не найден"}
                    className={`w-10 h-10 rounded-md flex items-center justify-center font-display text-xs transition-colors ${
                      got ? "anim-chip shadow-[0_4px_14px_rgba(0,0,0,0.45)]" : "border border-dashed border-slate-600 text-slate-600 bg-night-900/60"
                    }`}
                    style={got ? { background: cl.color, color: cl.ink } : undefined}
                  >
                    {got ? cl.mark : "?"}
                  </div>
                );
              })}
            </div>
          </div>

          {/* центр сверху: панель заправки (управление на это время заблокировано) */}
          <div
            ref={refuelPanelRef}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex-col items-center gap-1.5 bg-night-900/92 border border-[#7ee08a]/45 rounded-xl px-5 py-3 shadow-[0_14px_40px_rgba(0,0,0,0.55)]"
            style={{ display: "none" }}
          >
            <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[#7ee08a] font-bold anim-blink">
              <FuelIcon className="w-4 h-4" />
              идёт заправка
            </span>
            <span ref={refuelLitersRef} className="font-display text-2xl text-[#d6f7dc] tabular-nums leading-none">
              0 / 50 л
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="text-[#58c9f3]">
                <CanisterIcon className="w-4 h-4" />
              </span>
              канистр у тебя:
              <span ref={canisterCountRef} className="font-display text-slate-200 tabular-nums">
                0
              </span>
            </span>
            <span className="text-[10px] text-slate-500">машина стоит — управление заблокировано</span>
          </div>

          {/* левый низ: топливо и спидометр */}
          <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
            <div className="bg-night-900/85 border border-night-600 rounded-lg p-3 flex flex-col gap-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.4)]">
              {/* шкала топлива */}
              <div className="w-[228px] flex items-center gap-2.5 pb-2 border-b border-night-700">
                <span ref={fuelIconRef} className="shrink-0" style={{ color: "#7ee08a" }}>
                  <FuelIcon />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-semibold">Топливо</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span
                        ref={canisterHudRef}
                        title="Канистр у тебя"
                        className="flex items-center gap-0.5 text-[#58c9f3]"
                        style={{ opacity: 0.45 }}
                      >
                        <CanisterIcon className="w-3 h-3" />
                        <span ref={canisterHudCountRef} className="font-display text-[10px] tabular-nums leading-none">
                          0
                        </span>
                      </span>
                      <span ref={fuelTextRef} className="font-display text-[11px] text-slate-300 tabular-nums leading-none">
                        50 л
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 mt-1 bg-night-950/80 border border-night-600 rounded-sm overflow-hidden">
                    <div ref={fuelFillRef} className="h-full rounded-[1px]" style={{ width: "100%", background: "#7ee08a" }} />
                  </div>
                </div>
                <span ref={refuelRef} className="font-display text-[10px] text-[#7ee08a] anim-blink shrink-0" style={{ display: "none" }}>
                  ЗАПРАВКА
                </span>
                <span ref={lowRef} className="font-display text-[10px] text-[#ff6b5a] anim-blink shrink-0" style={{ display: "none" }}>
                  НА АЗС!
                </span>
              </div>
              <div className="flex items-center gap-3">
              <svg viewBox="0 0 120 120" className="w-[116px] h-[116px]">
                <defs>
                  <linearGradient id="speedGrad" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#59d8c9" />
                    <stop offset="55%" stopColor="#ffb454" />
                    <stop offset="100%" stopColor="#ff6b4a" />
                  </linearGradient>
                </defs>
                <path
                  d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53"
                  fill="none"
                  stroke="#232b3c"
                  strokeWidth="9"
                  strokeLinecap="round"
                />
                <path
                  ref={arcRef}
                  d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53"
                  fill="none"
                  stroke="url(#speedGrad)"
                  strokeWidth="9"
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray="100"
                  strokeDashoffset="100"
                />
                {GAUGE_TICKS.map((t, i) => (
                  <circle key={i} cx={t.x} cy={t.y} r="2" fill="#3a4661" />
                ))}
                <g ref={needleRef} style={{ transformOrigin: "60px 60px" }}>
                  <line x1="60" y1="60" x2="31.7" y2="88.3" stroke="#f2ecdf" strokeWidth="3" strokeLinecap="round" />
                </g>
                <circle cx="60" cy="60" r="6" fill="#26314a" stroke="#59627a" strokeWidth="2" />
              </svg>
              <div className="pr-1">
                <div className="flex items-baseline gap-1.5">
                  <span ref={speedTextRef} className="font-display text-4xl text-[#f2ecdf] tabular-nums leading-none">
                    0
                  </span>
                  <span className="text-[11px] text-slate-500 font-semibold">км/ч</span>
                </div>
                <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                  ночная смена
                </div>
              </div>
              </div>
            </div>
          </div>

          {/* правый низ: легенда обозначений */}
          <div className="absolute bottom-4 right-4 z-10 pointer-events-none flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-3 text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-glow inline-block anim-pulse-soft" /> свободный щит
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-slate-500 inline-block" /> подписан
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-[2px] bg-[#f2a93b] inline-block anim-pulse-soft" /> АЗС работает
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-[2px] bg-[#333b49] border border-[#a34a3e] inline-block" /> нет топлива
              </span>
              <span className="flex items-center gap-1">
                <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 text-[#7ee08a]">
                  <path d="M4 12h13M13 7l5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                зелёная стрелка у края — направление и метры до работающей АЗС
              </span>
              <span className="flex items-center gap-1">
                <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 text-[#58c9f3]">
                  <path d="M4 12h13M13 7l5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                голубая — до канистры (+10 л к баку)
              </span>
            </div>
          </div>

          {/* подсказка по управлению */}
          {!touch && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 pointer-events-none hidden md:flex items-center gap-2 text-xs text-slate-400 bg-night-900/70 border border-night-600/60 rounded-full px-4 py-2">
              <span className="kbd">W</span>
              <span className="kbd">A</span>
              <span className="kbd">S</span>
              <span className="kbd">D</span>
              движение
              <span className="text-slate-600 mx-1">·</span>
              <span className="kbd">SPACE</span> ручник
              <span className="text-slate-600 mx-1">·</span>
              врезайся в янтарные щиты
            </div>
          )}

          {/* сенсорные кнопки */}
          {touch && !modal && (
            <div className="absolute bottom-24 inset-x-5 z-20 flex justify-between items-end">
              <div className="flex gap-3">
                <button {...hold("left")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-amber-glow flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button {...hold("right")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-amber-glow flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M9.5 5.5L16 12l-6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
              <div className="flex gap-3">
                <button {...hold("down")} className="w-16 h-16 rounded-full bg-night-800/85 border border-night-600 text-[#ff8a70] flex items-center justify-center active:bg-night-600 touch-none">
                  <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7"><path d="M5.5 9.5L12 16l6.5-6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button {...hold("up")} className="w-20 h-20 rounded-full bg-amber-glow/90 border border-[#ffd9a0] text-night-950 flex items-center justify-center active:bg-amber-glow touch-none shadow-[0_6px_20px_rgba(255,180,84,0.4)]">
                  <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8"><path d="M5.5 14.5L12 8l6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* тост */}
      {toast && (
        <div
          key={toast.id}
          className="absolute top-16 left-1/2 -translate-x-1/2 z-50 anim-toast bg-night-800/95 border border-amber-glow/40 text-amber-glow text-sm font-medium rounded-md px-4 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        >
          {toast.msg}
        </div>
      )}

      {/* ================= стартовый экран ================= */}
      {phase === "menu" && (
        <div className="absolute inset-0 z-30">
          <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(7,10,20,0.94)_0%,rgba(7,10,20,0.72)_42%,rgba(7,10,20,0.28)_100%)]" />
          <div className="relative h-full flex flex-col justify-between p-5 md:p-10">
            {/* верхняя планка */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-amber-glow">
                <BillBoardIcon />
                <span className="font-display tracking-[0.14em] text-sm text-[#f2ecdf]">
                  БИЛБОРД <span className="text-amber-glow">РАЛЛИ</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline text-[10px] uppercase tracking-[0.2em] text-slate-500 border border-night-600 rounded-full px-3 py-1.5">
                  медиа-агентство «Щит и Пика»
                </span>
                <button
                  onClick={toggleMute}
                  className="w-10 h-10 rounded-md bg-night-900/85 border border-night-600 flex items-center justify-center text-slate-400 hover:text-amber-glow transition-colors"
                  aria-label="Звук"
                >
                  <SpeakerIcon muted={muted} />
                </button>
              </div>
            </div>

            {/* нижний блок */}
            <div className="flex items-end justify-between gap-8 flex-wrap md:flex-nowrap">
              <div className="max-w-xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-glow/40 bg-amber-glow/10 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-glow">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-glow anim-pulse-soft" />
                  вид сверху · ночная смена · {CLIENTS.length} клиентов
                </div>
                <h1 className="font-display text-[52px] md:text-[84px] leading-[0.95] mt-5 text-[#f2ecdf]">
                  БИЛБОРД
                  <br />
                  <span className="text-amber-glow">РАЛЛИ</span>
                </h1>
                <p className="mt-5 text-slate-300 leading-relaxed max-w-md">
                  Твои клиенты ждут рекламу. Гоняй по ночному району, находи свободные
                  билборды — они подсвечены янтарным — и врезайся в них, чтобы подписать
                  контракт. Каждый щит открывает лендинг клиента — и активирует
                  дополнительную заправку. В баке всего 50 литров, а после каждой заправки
                  станция закрывается: следующая выйдет в сеть через секунду. Кончится
                  топливо — смена сорвётся.
                </p>
                <div className="mt-7 flex items-center gap-5 flex-wrap">
                  <button
                    onClick={start}
                    className="rounded-md bg-amber-glow text-night-950 font-display text-base tracking-wide px-8 py-4 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-[0_10px_34px_rgba(255,180,84,0.4)]"
                  >
                    Выехать на маршрут
                  </button>
                  <span className="text-sm text-slate-500 anim-blink">
                    или нажми <span className="kbd">ENTER</span>
                  </span>
                </div>
              </div>

              {/* карточка управления */}
              <div className="w-full md:w-[300px] shrink-0 bg-night-900/85 border border-night-600 rounded-lg p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500 font-bold">Управление</div>
                <div className="mt-4 flex flex-col gap-3 text-sm text-slate-300">
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">W</span><span className="kbd">↑</span></span> газ
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">S</span><span className="kbd">↓</span></span> тормоз и задний ход
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex gap-1"><span className="kbd">A</span><span className="kbd">D</span></span> руль
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">SPACE</span> ручник — дрифт и следы
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="kbd">M</span> звук вкл/выкл
                  </div>
                </div>
                <div className="mt-5 pt-4 border-t border-night-700 flex items-start gap-2.5 text-xs text-slate-400 leading-relaxed">
                  <span className="mt-1 w-2 h-2 rounded-full bg-amber-glow shrink-0 anim-pulse-soft" />
                  Свободные щиты мигают на карте и в городе. Здания — прочные, газон — медленный.
                </div>
                <div className="mt-3 pt-3 border-t border-night-700 flex items-start gap-2.5 text-xs text-slate-400 leading-relaxed">
                  <span className="mt-0.5 text-[#f2a93b] shrink-0">
                    <FuelIcon className="w-4 h-4" />
                  </span>
                  Стартовый бак — 50 л, работающая АЗС льёт 10 л/с. Кто первым встал под колонку, тот
                  её и занял: АЗС закрывается сразу, а другая случайная открывается через{" "}
                  {CONFIG.stationTimeoutBase} с плюс {CONFIG.stationTimeoutPerCanister} с за каждую
                  канистру заправляющегося. Просмотр рекламы на билборде активирует дополнительную АЗС —
                  но заправка на ней новых станций не открывает. По городу катаются конкуренты: они тоже
                  забирают канистры и занимают колонки. Пустой бак — начинаешь заново.
                </div>
              </div>
            </div>

            <div className="stripes-amber h-2.5 mt-6 rounded-sm opacity-70" />
          </div>
        </div>
      )}

      {/* ================= победа ================= */}
      {win && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(5,8,16,0.6)] anim-fade" onClick={() => setWin(null)} />
          <div className="relative bg-night-800 border border-night-600 rounded-xl p-8 max-w-md w-full text-center anim-pop shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
            <div className="flex justify-center">
              <TrophyIcon />
            </div>
            <h2 className="font-display text-3xl md:text-4xl text-[#f2ecdf] mt-4 leading-tight">
              Все билборды <span className="text-amber-glow">проданы!</span>
            </h2>
            <p className="mt-3 text-slate-400 leading-relaxed">
              {CLIENTS.length} клиентов подписали контракты за одну смену. Отдел продаж аплодирует стоя, город сияет вашей рекламой.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-aqua-glow tabular-nums">{fmt(win.time)}</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">время смены</div>
              </div>
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-amber-glow tabular-nums">{win.top} км/ч</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">макс. скорость</div>
              </div>
            </div>
            <div className="mt-7 flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={restart}
                className="rounded-md bg-amber-glow text-night-950 font-display text-sm tracking-wide px-6 py-3.5 hover:brightness-110 hover:-translate-y-0.5 transition-all duration-200 shadow-[0_8px_24px_rgba(255,180,84,0.35)]"
              >
                Новый заезд
              </button>
              <button
                onClick={() => setWin(null)}
                className="rounded-md border border-night-600 text-slate-300 font-display text-sm tracking-wide px-6 py-3.5 hover:border-slate-500 hover:text-[#f2ecdf] transition-colors"
              >
                Кататься дальше
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= кончилось топливо ================= */}
      {gameover && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(5,8,16,0.74)] anim-fade" />
          <div className="relative bg-night-800 border border-[#5a2c24] rounded-xl p-8 max-w-md w-full text-center anim-pop shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
            <div className="flex justify-center text-[#ff6b5a]">
              <FuelIcon className="w-10 h-10" />
            </div>
            <h2 className="font-display text-3xl md:text-4xl text-[#f2ecdf] mt-4 leading-tight">
              Бензин <span className="text-[#ff6b5a]">кончился!</span>
            </h2>
            <p className="mt-3 text-slate-400 leading-relaxed">
              Машина заглохла посреди города. В следующий раз закладывай маршрут до АЗС —
              зелёная стрелка у края экрана всегда показывает направление и метры до
              работающей колонки, голубая — до канистры.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-amber-glow tabular-nums">
                  {gameover.found}
                  <span className="text-sm text-slate-500">/{CLIENTS.length}</span>
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">клиентов подписано</div>
              </div>
              <div className="bg-night-900/80 border border-night-700 rounded-lg py-4">
                <div className="font-display text-2xl text-aqua-glow tabular-nums">{fmt(gameover.time)}</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mt-1">время в пути</div>
              </div>
            </div>
            <button
              onClick={restart}
              className="mt-7 w-full rounded-md bg-[#ff6b5a] text-night-950 font-display text-sm tracking-wide px-6 py-4 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-[0_8px_24px_rgba(255,107,90,0.35)]"
            >
              Начать заново
            </button>
            <div className="mt-3 text-xs text-slate-500">
              или нажми <span className="kbd">ENTER</span>
            </div>
          </div>
        </div>
      )}

      {/* ================= лендинг клиента ================= */}
      {modal && (
        <ClientModal
          client={modal.client}
          index={modal.index}
          total={CLIENTS.length}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/** Крошечный WebAudio-синтезатор: гул мотора, сигналы, удары. Без внешних ассетов. */
class Sfx {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private engOsc: OscillatorNode | null = null;
  private engOsc2: OscillatorNode | null = null;
  private engGain: GainNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engineOn = false;
  muted = false;

  init(): void {
    try {
      if (!this.ac) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ac = new AC();
        this.master = this.ac.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ac.destination);
      }
      if (this.ac.state === "suspended") void this.ac.resume();
    } catch {
      this.ac = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ac) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ac.currentTime, 0.05);
    }
  }

  /** завести мотор */
  engineStart(): void {
    if (!this.ac || !this.master || this.engineOn) return;
    try {
      this.engOsc = this.ac.createOscillator();
      this.engOsc.type = "sawtooth";
      this.engOsc.frequency.value = 58;
      this.engOsc2 = this.ac.createOscillator();
      this.engOsc2.type = "square";
      this.engOsc2.frequency.value = 29;
      this.engFilter = this.ac.createBiquadFilter();
      this.engFilter.type = "lowpass";
      this.engFilter.frequency.value = 420;
      this.engGain = this.ac.createGain();
      this.engGain.gain.value = 0;
      this.engOsc.connect(this.engFilter);
      this.engOsc2.connect(this.engFilter);
      this.engFilter.connect(this.engGain);
      this.engGain.connect(this.master);
      this.engOsc.start();
      this.engOsc2.start();
      this.engineOn = true;
    } catch {
      this.engineOn = false;
    }
  }

  /** каждый кадр: speed01 — скорость 0..1, load01 — газ 0..1 */
  engine(speed01: number, load01: number): void {
    if (!this.ac || !this.engineOn || !this.engOsc || !this.engOsc2 || !this.engGain || !this.engFilter) return;
    const t = this.ac.currentTime;
    this.engOsc.frequency.setTargetAtTime(55 + speed01 * 128, t, 0.07);
    this.engOsc2.frequency.setTargetAtTime(27 + speed01 * 64, t, 0.07);
    this.engFilter.frequency.setTargetAtTime(320 + speed01 * 900, t, 0.09);
    const g = 0.016 + load01 * 0.034 + speed01 * 0.026;
    this.engGain.gain.setTargetAtTime(g, t, 0.12);
  }

  engineIdle(): void {
    if (!this.ac || !this.engineOn || !this.engGain || !this.engOsc || !this.engOsc2) return;
    const t = this.ac.currentTime;
    this.engOsc.frequency.setTargetAtTime(52, t, 0.2);
    this.engOsc2.frequency.setTargetAtTime(26, t, 0.2);
    this.engGain.gain.setTargetAtTime(0.012, t, 0.2);
  }

  /** разблокировка новой заправки */
  unlock(): void {
    this.tone([392, 587, 880], 0.08, "square", 0.085, 0.03);
  }

  /** станция израсходована — закрылась */
  stationLock(): void {
    this.tone([330, 196], 0.11, "square", 0.075, 0);
  }

  /** радостный перезвон при подписании клиента */
  chime(): void {
    this.tone([523, 659, 784, 1046], 0.09, "triangle", 0.16, 0.05);
  }

  win(): void {
    this.tone([392, 523, 659, 784, 1046, 1318], 0.12, "triangle", 0.16, 0.06);
  }

  thud(): void {
    if (!this.ac || !this.master) return;
    try {
      const t = this.ac.currentTime;
      const dur = 0.14;
      const buf = this.ac.createBuffer(1, this.ac.sampleRate * dur, this.ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      const f = this.ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 260;
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);
    } catch {
      /* тишина */
    }
  }

  tick(): void {
    this.tone([1180], 0.05, "square", 0.045, 0);
  }

  /** предупреждение: мало топлива */
  warn(): void {
    this.tone([880, 640], 0.15, "square", 0.06, 0);
  }

  /** капля бензина при заправке */
  blip(): void {
    this.tone([1500 + Math.random() * 260], 0.05, "sine", 0.05, 0);
  }

  /** бак полон */
  tankFull(): void {
    this.tone([660, 880, 1320], 0.08, "triangle", 0.13, 0.03);
  }

  /** мотор заглох */
  stall(): void {
    if (!this.ac || !this.master) return;
    try {
      const t = this.ac.currentTime;
      const osc = this.ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(26, t + 0.7);
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0.17, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.78);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.85);
    } catch {
      /* тишина */
    }
  }

  private tone(freqs: number[], step: number, type: OscillatorType, vol: number, offset: number): void {
    if (!this.ac || !this.master) return;
    try {
      const t0 = this.ac.currentTime + offset;
      freqs.forEach((fr, i) => {
        const t = t0 + i * step;
        const osc = this.ac!.createOscillator();
        osc.type = type;
        osc.frequency.value = fr;
        const g = this.ac!.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.34);
        osc.connect(g);
        g.connect(this.master!);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    } catch {
      /* тишина */
    }
  }
}

export const sfx = new Sfx();

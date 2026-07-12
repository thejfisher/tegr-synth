/**
 * TEGR AudioWorklet Processor
 * ===========================
 * Implements the 10D teleparallel state vector as a real-time audio engine.
 * Each voice is a resonant wave defect: sin(θ_hue) driven through a γ-wavefolder.
 *
 * State Vector X^M = [t, x, y, z, px, py, pz, m0, θ_hue, γ]
 *
 * Audio mapping:
 *   θ_hue → oscillator phase
 *   m₀    → base angular frequency (pitch)
 *   γ     → wavefolder saturation (drive/distortion)
 *   x     → stereo pan (L/R)
 *   y     → stereo width (phase offset between L/R)
 *   z     → psychoacoustic depth (lowpass + volume rolloff)
 *   Λ     → vacuum damping (amplitude decay / release)
 */

class TEGRVoice {
  constructor(note, velocity) {
    this.note = note;
    this.active = true;
    this.releasing = false;

    // Frequency from MIDI note
    const freq = 440 * Math.pow(2, (note - 69) / 12);

    // --- 10D State Vector ---
    this.t = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.px = 0;
    this.py = 0;
    this.pz = 0;
    this.m0 = 2 * Math.PI * freq;         // angular frequency = mass-energy
    this.theta = Math.random() * 0.001;    // tiny random phase to avoid sync artifacts
    this.gamma = 1.0;                      // relativistic tension (Lorentz factor)

    // Audio envelope
    this.amplitude = (velocity / 127) * 0.8;
    this.peakAmplitude = this.amplitude;

    // Spin-vorticity
    this.omega = Math.random() > 0.5 ? 0.5 : -0.5;

    // Z-depth one-pole lowpass filter state
    this.lpStateL = 0;
    this.lpStateR = 0;

    // Firewall burst state (samples remaining)
    this.firewallSamples = 0;
  }
}

class TEGRProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.voices = new Map();
    this.mode = 'natural';           // 'natural' | 'sandbox'
    this.ereprEnabled = false;
    this.ereprPair = null;           // { noteA, noteB, active, deltaGamma }

    // Parameter values (controlled by UI dials)
    this.params = {
      m0_offset:   0,       // pitch fine-tune in cents
      gamma_drive: 1.0,     // wavefolder tension (1.0 – 10.0)
      lambda_vac:  2.0,     // decay time constant in seconds
      torsion_g:   0.0,     // torsion cross-coupling (0 – 1)
      pauli_chi:   0.0,     // Pauli exchange pressure (0 – 1)
      x_pos:       0.0,     // stereo pan  (-1 … +1)
      y_width:     0.0,     // stereo width (0 … 1)
      z_depth:     0.0,     // psychoacoustic depth (0 … 1)
      master_vol:  0.7,     // master volume (0 … 1)
    };

    // Lock states for Sandbox mode (true = parameter is frozen)
    this.locks = {
      m0: false,
      gamma: false,
      theta: false,
      x: false,
      y: false,
      z: false,
      lambda: false,
      torsion: false,
      pauli: false,
    };

    this.vizCounter = 0;
    this.vizInterval = 512;           // send viz data every N samples

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(data) {
    switch (data.type) {
      case 'noteOn': {
        const voice = new TEGRVoice(data.note, data.velocity);
        this.voices.set(data.note, voice);
        this.updateEREPR();
        break;
      }
      case 'noteOff': {
        const v = this.voices.get(data.note);
        if (v) v.releasing = true;
        break;
      }
      case 'param':
        if (data.name in this.params) {
          this.params[data.name] = data.value;
        }
        break;
      case 'mode':
        this.mode = data.mode;
        break;
      case 'lock':
        if (data.param in this.locks) {
          this.locks[data.param] = data.locked;
        }
        break;
      case 'erepr':
        this.ereprEnabled = data.enabled;
        this.updateEREPR();
        break;
    }
  }

  /** Entangle the two most recently activated voices */
  updateEREPR() {
    if (!this.ereprEnabled) { this.ereprPair = null; return; }
    const active = [];
    for (const [note, v] of this.voices) {
      if (v.active && !v.releasing) active.push(note);
    }
    if (active.length >= 2) {
      const a = active[active.length - 2];
      const b = active[active.length - 1];
      this.ereprPair = { noteA: a, noteB: b, active: true, deltaGamma: 0 };
      // Anti-correlate spins
      const vB = this.voices.get(b);
      const vA = this.voices.get(a);
      if (vA && vB) vB.omega = -vA.omega;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const left  = output[0];
    const right = output[1];
    const dt    = 1.0 / sampleRate;
    const len   = left.length;

    // Collect active voices into array for iteration
    const activeList = [];
    for (const [note, v] of this.voices) {
      if (v.active) activeList.push(v);
    }

    for (let i = 0; i < len; i++) {
      let sumL = 0;
      let sumR = 0;

      // ── ER=EPR Phase Synchronization ──────────────────────
      if (this.ereprPair && this.ereprPair.active) {
        const vA = this.voices.get(this.ereprPair.noteA);
        const vB = this.voices.get(this.ereprPair.noteB);
        if (vA && vB && vA.active && vB.active) {
          // Bidirectional phase averaging (Paper 3 correction)
          const mid = (vA.theta + vB.theta) * 0.5;
          const pull = 0.005;                  // gentle sync rate
          vA.theta += (mid - vA.theta) * pull;
          vB.theta += (mid - vB.theta) * pull;

          // Monitor tension differential
          this.ereprPair.deltaGamma = Math.abs(vA.gamma - vB.gamma);

          // No AMPS Firewall - bond never snaps (brakes taken off)
        } else {
          this.ereprPair.active = false;
        }
      }

      // ── Per-Voice Processing ───────────────────────────────
      for (let vi = 0; vi < activeList.length; vi++) {
        const v = activeList[vi];
        if (!v.active) continue;

        // 1. Advance time
        v.t += dt;

        // 2. Effective γ
        let gammaEff;
        if (this.mode === 'sandbox' && !this.locks.gamma) {
          gammaEff = this.params.gamma_drive;
        } else {
          gammaEff = v.gamma;
        }
        gammaEff = Math.max(1.0, gammaEff);

        // In sandbox, allow UI to override gamma even if locked
        if (this.mode === 'sandbox') {
          v.gamma = this.params.gamma_drive;
        }

        // 3. Phase evolution ── THE OSCILLATOR ──
        const centsMultiplier = Math.pow(2, this.params.m0_offset / 1200);
        const m0eff = v.m0 * centsMultiplier;

        if (this.mode === 'natural') {
          // Time dilation: γ slows the internal clock
          v.theta += (m0eff / gammaEff) * dt;
        } else if (this.mode === 'adler') {
          // The Relativistic Adler Equation (RAE) Override
          // \dot{\theta} = \alpha(m0 / \gamma) - \kappa \sin(\theta) + \nabla \Phi
          const kappa = this.params.lambda_vac * 15.0;  // Restoring phase-spring
          const gradPhi = this.params.pauli_chi * 50.0; // Spatial strain driving force
          v.theta += ( (m0eff / gammaEff) - kappa * Math.sin(v.theta) + gradPhi ) * dt;
        } else {
          // Sandbox: γ only affects waveshaping, not pitch
          v.theta += m0eff * dt;
        }

        // 4. Generate raw waveform
        const rawL = Math.sin(v.theta);

        // Y-width: slightly detuned phase for R channel
        const width = this.locks.y ? 0 : this.params.y_width;
        const phaseOffset = width * 0.15;       // up to 0.15 rad offset
        const rawR = Math.sin(v.theta + phaseOffset);

        // 5. WAVEFOLDER: γ-driven saturation
        //    tanh(γ × sin(θ)) — higher γ → more harmonic saturation
        let sampleL = Math.tanh(gammaEff * rawL);
        let sampleR_base = Math.tanh(gammaEff * rawR);

        // Blend L/R based on width (0 = mono, 1 = full stereo)
        let sampleR = sampleL * (1.0 - width) + sampleR_base * width;

        // 6. Torsion coupling (adds harmonic overtones)
        if (this.params.torsion_g > 0.001) {
          const t_g = this.params.torsion_g;
          // Spin-gravity precession: cross-term overtone at 2×θ
          const overtone = Math.sin(v.theta * 2.0 + v.omega * v.t * 0.5);
          const torsionAmt = t_g * 0.25 * overtone;
          sampleL += torsionAmt;
          sampleR += torsionAmt;
        }

        // 7. Pauli exchange (Natural mode: multi-voice interaction)
        if (this.mode === 'natural' && this.params.pauli_chi > 0.001 && activeList.length > 1) {
          let gammaShift = 0;
          for (let vj = 0; vj < activeList.length; vj++) {
            if (vj === vi) continue;
            const other = activeList[vj];
            if (!other.active) continue;
            const dtheta = v.theta - other.theta;
            gammaShift += this.params.pauli_chi * Math.cos(dtheta) * 0.0005;
          }
          v.gamma += gammaShift;
          v.gamma = Math.max(1.0, v.gamma);
        }

        // 8. Firewall noise burst
        if (v.firewallSamples > 0) {
          const burstNorm = v.firewallSamples / 6000;
          const noise = (Math.random() * 2 - 1) * 0.6 * burstNorm;
          sampleL += noise;
          sampleR += noise * (Math.random() > 0.5 ? 1 : -1);   // stereo noise
          v.firewallSamples--;
        }

        // 9. Amplitude envelope
        sampleL *= v.amplitude;
        sampleR *= v.amplitude;

        // 10. Decay
        if (v.releasing) {
          // Release: exponential decay governed by Λ
          const tau = Math.max(0.02, this.params.lambda_vac * 0.5);
          v.amplitude *= Math.exp(-dt / tau);
          if (v.amplitude < 0.0005) {
            v.active = false;
            continue;
          }
        } else if (this.mode === 'natural') {
          // Natural vacuum damping while held (very gentle)
          const sustainTau = Math.max(0.5, this.params.lambda_vac * 5.0);
          v.amplitude *= Math.exp(-dt / sustainTau);
          if (v.amplitude < 0.001) v.amplitude = 0.001; // never fully die while held
        }

        // 11. Z-Depth: psychoacoustic distance
        //     One-pole lowpass + volume rolloff
        const depth = this.locks.z ? 0 : this.params.z_depth;
        if (depth > 0.01) {
          const lpCoeff = Math.max(0.02, 1.0 - depth * 0.92);
          v.lpStateL += lpCoeff * (sampleL - v.lpStateL);
          v.lpStateR += lpCoeff * (sampleR - v.lpStateR);
          sampleL = v.lpStateL;
          sampleR = v.lpStateR;
          // Volume reduction with distance
          const distAtten = 1.0 - depth * 0.45;
          sampleL *= distAtten;
          sampleR *= distAtten;
        }

        // 12. X-Pan: equal-power stereo panning
        const pan = this.locks.x ? 0 : this.params.x_pos;
        const panNorm = (pan + 1.0) * 0.5;                    // 0…1
        const gainL = Math.cos(panNorm * Math.PI * 0.5);
        const gainR = Math.sin(panNorm * Math.PI * 0.5);

        sumL += sampleL * gainL;
        sumR += sampleR * gainR;
      }

      // ── Master output with soft limiter ──
      const vol = this.params.master_vol;
      left[i]  = Math.tanh(sumL * vol * 0.6);
      right[i] = Math.tanh(sumR * vol * 0.6);
    }

    // ── Visualization data ──────────────────────────────────
    this.vizCounter += len;
    if (this.vizCounter >= this.vizInterval) {
      this.vizCounter = 0;
      const vizVoices = [];
      for (const [note, v] of this.voices) {
        if (v.active) {
          vizVoices.push({
            note:      v.note,
            theta:     v.theta % (2 * Math.PI),
            gamma:     v.gamma,
            m0:        v.m0,
            amplitude: v.amplitude,
            omega:     v.omega,
          });
        }
      }
      this.port.postMessage({
        type:  'viz',
        voices: vizVoices,
        erepr:  this.ereprPair ? {
          noteA:      this.ereprPair.noteA,
          noteB:      this.ereprPair.noteB,
          active:     this.ereprPair.active,
          deltaGamma: this.ereprPair.deltaGamma,
        } : null,
      });
    }

    // ── Garbage-collect dead voices ──
    for (const [note, v] of this.voices) {
      if (!v.active) this.voices.delete(note);
    }

    return true;
  }
}

registerProcessor('tegr-processor', TEGRProcessor);

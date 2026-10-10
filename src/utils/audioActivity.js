// Classifies microphone audio from Web Audio analyser readings (~every
// 80 ms) into: 'speech' (incl. quiet speech), 'noise' (steady background
// sound), 'silence', or 'no-signal' (exact digital zeros — the device is
// muted at the hardware/OS level or has failed; a working microphone always
// picks up some room noise).
//
// Everything is relative to an adaptive noise floor, so a soft voice in a
// quiet room counts as sound while a steady fan in a noisy room fades into
// the background after a few seconds.

export const MIC = {
  // Below this level nothing counts as sound (electrical/dither noise).
  ABS_MIN_DB: -72,
  // Sound = this many dB above the room's current noise floor.
  ACTIVE_SNR_DB: 5,
  FLOOR_INIT_DB: -90,
  FLOOR_MIN_DB: -100,
  FLOOR_MAX_DB: -20,
  // The floor drops quickly to quieter readings but rises slowly, so a
  // steady noise is learned in seconds while a voice (with pauses between
  // words) never becomes "background".
  FLOOR_RISE_DB_PER_S: 3,
  FLOOR_FALL: 0.35,
  // Meter: 0 at the noise floor, full at this many dB above it.
  METER_RANGE_DB: 36,
  // Speech energy sits mostly in the telephone band.
  SPEECH_BAND_HZ: [300, 3400],
  FULL_BAND_HZ: [80, 8000],
  SPEECH_BAND_SHARE: 0.5,
  // Speech rises and falls with syllables; steady noise does not.
  WINDOW_MS: 1200,
  SPEECH_MODULATION_DB: 3,
  SPEECH_HANGOVER_MS: 500,
  NOISE_ACTIVE_SHARE: 0.5,
  // A floor this high means a noisy room even once the noise is learned.
  NOISY_FLOOR_DB: -55,
  NO_SIGNAL_MS: 3000,
  // System Check proof: sound in at least this many readings within 1 s
  // (a single click or tap is not enough; soft speech with pauses is).
  INPUT_WINDOW_MS: 1000,
  INPUT_MIN_ACTIVE_READINGS: 3,
};

export function signalStats(samples) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { db: rms > 0 ? 20 * Math.log10(rms) : -Infinity, peak };
}

// Share of 80–8000 Hz energy that falls in the speech band, from an
// analyser's dB spectrum (bin i covers i * sampleRate / fftSize Hz).
export function speechBandShare(spectrumDb, sampleRate) {
  if (!spectrumDb?.length || !sampleRate) return null;
  const binHz = sampleRate / (2 * spectrumDb.length);
  const [speechLo, speechHi] = MIC.SPEECH_BAND_HZ;
  const [fullLo, fullHi] = MIC.FULL_BAND_HZ;
  let speech = 0;
  let total = 0;
  for (let i = 0; i < spectrumDb.length; i += 1) {
    const hz = i * binHz;
    if (hz < fullLo || hz > fullHi || !Number.isFinite(spectrumDb[i])) continue;
    const power = 10 ** (spectrumDb[i] / 10);
    total += power;
    if (hz >= speechLo && hz <= speechHi) speech += power;
  }
  return total > 0 ? speech / total : null;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

export function createAudioActivityAnalyzer() {
  let floorDb = MIC.FLOOR_INIT_DB;
  let lastTime = null;
  let history = []; // { t, db, active, inBand }
  let zeroSince = null;
  let lastSpeech = -Infinity;

  return {
    // samples: Float32 time-domain (-1..1); spectrumDb: Float32 analyser
    // frequency data (optional); returns the reading for this moment.
    update(now, samples, spectrumDb, sampleRate) {
      const { db, peak } = signalStats(samples);
      const reading = Number.isFinite(db) ? db : MIC.FLOOR_MIN_DB;
      const dt = lastTime === null ? 0 : Math.min(1, Math.max(0, now - lastTime) / 1000);
      lastTime = now;

      const snr = reading - floorDb;
      const active = reading > MIC.ABS_MIN_DB && snr >= MIC.ACTIVE_SNR_DB;
      if (reading < floorDb) floorDb += (reading - floorDb) * MIC.FLOOR_FALL;
      else floorDb = Math.min(reading, floorDb + MIC.FLOOR_RISE_DB_PER_S * dt);
      floorDb = Math.max(MIC.FLOOR_MIN_DB, Math.min(MIC.FLOOR_MAX_DB, floorDb));

      // Without spectrum data the band check is skipped.
      const share = speechBandShare(spectrumDb, sampleRate);
      const inBand = share === null || share >= MIC.SPEECH_BAND_SHARE;
      history.push({ t: now, db: reading, active });
      history = history.filter((h) => now - h.t <= MIC.WINDOW_MS);

      // Level variation over the window, with quiet gaps counted at the
      // floor so pauses between words register as variation.
      const modulation = stdDev(history.map((h) => Math.max(h.db, floorDb)));
      if (active && inBand && modulation >= MIC.SPEECH_MODULATION_DB) lastSpeech = now;

      if (peak === 0) zeroSince ??= now;
      else zeroSince = null;
      const noSignalMs = zeroSince === null ? 0 : now - zeroSince;
      const activeShare = history.filter((h) => h.active).length / history.length;

      let activity = 'silence';
      if (noSignalMs >= MIC.NO_SIGNAL_MS) activity = 'no-signal';
      else if (now - lastSpeech <= MIC.SPEECH_HANGOVER_MS) activity = 'speech';
      else if (activeShare >= MIC.NOISE_ACTIVE_SHARE || floorDb >= MIC.NOISY_FLOOR_DB) activity = 'noise';

      const level = reading > MIC.ABS_MIN_DB
        ? Math.max(0, Math.min(100, Math.round((snr / MIC.METER_RANGE_DB) * 100)))
        : 0;
      const recentActive = history.filter((h) => h.active && now - h.t <= MIC.INPUT_WINDOW_MS).length;

      return {
        level, db: reading, floorDb, active, activity, noSignalMs,
        inputConfirmed: recentActive >= MIC.INPUT_MIN_ACTIVE_READINGS,
      };
    },
  };
}

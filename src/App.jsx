import React, { useState, useEffect, useMemo } from 'react';
import { Play, Plus, Trash2, Settings2, Beaker, Atom, Info, Activity, Loader2 } from 'lucide-react';
import Plot from 'react-plotly.js';

// --- Constants ---
const C_CM_S = 2.99792458e10;
const C_M_S = 2.99792458e8;

// --- Helper Functions ---
const cm1ToRadS = (shift) => 2.0 * Math.PI * C_CM_S * shift;
const fwhmToSigmaT = (fwhm) => fwhm / (2.0 * Math.sqrt(Math.log(2.0)));
const lamNmToW = (lam) => (2.0 * Math.PI * C_M_S) / (lam * 1e-9);

// Linear interpolation (np.interp equivalent)
const interp = (x, xp, fp) => {
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let i = 0;
  while (x > xp[i + 1]) i++;
  const x0 = xp[i], x1 = xp[i + 1];
  const y0 = fp[i], y1 = fp[i + 1];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
};

const App = () => {
  const [lasers, setLasers] = useState({
    pump: { lam: 800, fwhm: 15, delay: -50, chirp: 0 },
    stokes: { lam: 1030, fwhm: 15, delay: -50, chirp: 0 },
    probe: { lam: 800, fwhm: 60, delay: 100, chirp: 0 },
  });

  // Modos vibracionales del Metano (CH4) precargados
  const [modes, setModes] = useState([
    { id: 1, shift: 2917, strength: 1.0, t2: 2.0 },  // v1 (Symmetric stretch)
    { id: 2, shift: 3019, strength: 0.8, t2: 1.8 },  // v3 (Asymmetric stretch)
    { id: 3, shift: 1534, strength: 0.35, t2: 2.5 }, // v2 (Bending)
    { id: 4, shift: 1306, strength: 0.45, t2: 2.5 }, // v4 (Bending)
  ]);

  const [nrb, setNrb] = useState(0.0);
  const [activeTab, setActiveTab] = useState('fast-cars-spectrum');
  const [normalize, setNormalize] = useState(false); // Nuevo estado para la deconvolución

  // --- NUEVO: Sistema de Debounce ---
  const [debouncedLasers, setDebouncedLasers] = useState(lasers);
  const [debouncedModes, setDebouncedModes] = useState(modes);
  const [debouncedNrb, setDebouncedNrb] = useState(nrb);
  const [isCalculating, setIsCalculating] = useState(false);

  useEffect(() => {
    setIsCalculating(true);
    const timer = setTimeout(() => {
      setDebouncedLasers(lasers);
      setDebouncedModes(modes);
      setDebouncedNrb(nrb);
      setIsCalculating(false);
    }, 350); // 350ms de retraso al escribir/mover sliders
    return () => clearTimeout(timer);
  }, [lasers, modes, nrb]);

  const simulation = useMemo(() => {
    // 1. Grid Principal
    const dt = 0.5e-15;
    const n = 32768; 
    const half = Math.floor(n / 2);
    const t_grid = Array.from({ length: n }, (_, i) => (i - half) * dt);

    // 2. Chi(t) - Impulsive vibrational response
    const chiR = t_grid.map(ti => {
      if (ti < 0) return 0;
      let val = 0;
      debouncedModes.forEach(m => {
        const w = cm1ToRadS(m.shift);
        val += m.strength * Math.exp(-ti / (m.t2 * 1e-12)) * Math.sin(w * ti);
      });
      return val;
    });

    const nrbSigma = 40e-15;
    const nrbScale = 5e-13;
    const chiNR = t_grid.map(ti => 
      ((debouncedNrb * nrbScale) / (Math.sqrt(2 * Math.PI) * nrbSigma)) * Math.exp(-(ti ** 2) / (2 * nrbSigma ** 2))
    );
    const chiTotal = chiR.map((r, i) => r + chiNR[i]);

    // --- CÁLCULO FÍSICO REAL DE LA EXCITACIÓN ---
    const getEnvelopeAndPhase = (params) => {
        const w0 = lamNmToW(params.lam);
        const sigma = fwhmToSigmaT(params.fwhm * 1e-15);
        const t0 = params.delay * 1e-15;
        const b = params.chirp * 1e27;
        return t_grid.map(ti => {
          const tau = ti - t0;
          const env = Math.exp(-(tau ** 2) / (2 * sigma ** 2));
          const chirpPhase = 0.5 * b * (tau ** 2);
          return { env, chirpPhase, phase: -w0 * ti + chirpPhase };
        });
    };
    
    const env_p = getEnvelopeAndPhase(debouncedLasers.pump);
    const env_s = getEnvelopeAndPhase(debouncedLasers.stokes);
    const env_pr = getEnvelopeAndPhase(debouncedLasers.probe);
    
    const plotStep = 10;
    const pulseTime = [];
    const pumpInt = [];
    const stokesInt = [];
    const probeInt = [];

    for (let i = 0; i < n; i += plotStep) {
      pulseTime.push(t_grid[i] * 1e15);
      pumpInt.push(env_p[i].env ** 2);
      stokesInt.push(env_s[i].env ** 2);
      probeInt.push(env_pr[i].env ** 2);
    }
    
    const F_eff = new Float64Array(n);
    let k_start = n, k_end = 0;
    let maxF = 0;
    
    for (let i = 0; i < n; i++) {
        const f = env_p[i].env * env_s[i].env * Math.cos(env_p[i].phase - env_s[i].phase);
        F_eff[i] = f;
        const absF = Math.abs(f);
        if (absF > maxF) maxF = absF;
    }
    
    const thresh = maxF * 1e-5; 
    for (let i = 0; i < n; i++) {
        const envProd = env_p[i].env * env_s[i].env; 
        if (envProd > thresh) {
            if (i < k_start) k_start = i;
            if (i > k_end) k_end = i;
        }
    }

    // Calcular la coherencia excitada real
    const rho = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = k_start; k <= k_end; k++) {
            const chi_idx = i - k + half;
            if (chi_idx >= 0 && chi_idx < n) {
                sum += chiTotal[chi_idx] * F_eff[k];
            }
        }
        rho[i] = sum;
    }

    // --- Calcular el Perfil Espectral de Excitación Láser ---
    const raman_cm1_axis = Array.from({ length: 1500 }, (_, i) => 500 + i * 2);
    let maxExc = 0;
    
    const excProfileRaw = raman_cm1_axis.map(cm1 => {
        const w = cm1ToRadS(cm1);
        let re = 0, im = 0;
        for(let k = k_start; k <= k_end; k += 2) { 
            const t = t_grid[k];
            re += F_eff[k] * Math.cos(w * t);
            im -= F_eff[k] * Math.sin(w * t);
        }
        const val = re**2 + im**2;
        if (val > maxExc) maxExc = val;
        return val;
    });
    
    const excProfileNorm = excProfileRaw.map(v => v / (maxExc || 1));

    // 3. FAST-CARS Interferogram 
    const fastN = 6000;
    const minDelay = -0.5e-12; 
    const maxDelay = 7.5e-12; 
    const dTau = (maxDelay - minDelay) / (fastN - 1);
    const delays_s = Array.from({ length: fastN }, (_, i) => minDelay + i * dTau);
    
    const rhoArray = Array.from(rho);
    const sigTotal = delays_s.map(tau => interp(tau, t_grid, rhoArray));
    
    const meanSig = sigTotal.length > 0 ? sigTotal.reduce((a, b) => a + b, 0) / sigTotal.length : 0;
    const sigAC = sigTotal.map(v => v - meanSig);

    // 4. FAST-CARS Spectrum (Con Normalización Opcional)
    let maxBandVal = 0;
    const fastCarsSpecRaw = raman_cm1_axis.map((cm1, idx) => {
      const w = cm1ToRadS(cm1);
      let re = 0, im = 0;
      for(let i = 0; i < fastN; i += 2) {
        const phase = -w * delays_s[i];
        re += sigAC[i] * Math.cos(phase);
        im += sigAC[i] * Math.sin(phase);
      }
      let val = Math.sqrt(re**2 + im**2)**2; 
      
      // Aplicar deconvolución si el usuario la activa
      if (normalize) {
         const excWeight = excProfileRaw[idx] / maxExc;
         // CORRECCIÓN: Umbral mucho más bajo (0.0001) para no cortar 
         // las colas del perfil de batido donde viven modos lejanos (ej. 1300 cm-1)
         if (excWeight > 0.0001) { 
             val = val / excWeight;
         } else {
             val = 0; 
         }
      }

      if (val > maxBandVal) maxBandVal = val;
      return val;
    });

    const fastCarsSpecNorm = fastCarsSpecRaw.map(v => v / (maxBandVal || 1));

    // 5. Conventional fs-CARS
    const P_re = new Float64Array(n);
    const P_im = new Float64Array(n);
    for(let i=0; i<n; i++) {
        const amp = rho[i] * env_pr[i].env;
        P_re[i] = amp * Math.cos(env_pr[i].chirpPhase);
        P_im[i] = amp * Math.sin(env_pr[i].chirpPhase);
    }

    const carsIntensity = raman_cm1_axis.map(s => {
        const w = cm1ToRadS(s);
        let sRe = 0, sIm = 0;
        for(let i=0; i<n; i+=2) { 
            const t = t_grid[i];
            const cosWt = Math.cos(w * t);
            const sinWt = Math.sin(w * t);
            sRe += P_re[i] * cosWt + P_im[i] * sinWt;
            sIm += P_im[i] * cosWt - P_re[i] * sinWt;
        }
        return Math.sqrt(sRe**2 + sIm**2);
    });

    return { 
        shiftAxis: raman_cm1_axis, 
        carsIntensity, 
        fastCarsX: delays_s.map(d => d * 1e12), 
        fastCarsSpecNorm,
        excProfileNorm,
        pulseTime,
        pumpInt,
        stokesInt,
        probeInt
    };
  }, [debouncedLasers, debouncedModes, debouncedNrb, normalize]);

  const updateLaser = (key, field, val) => setLasers(prev => ({ ...prev, [key]: { ...prev[key], [field]: parseFloat(val) || 0 } }));
  const updateMode = (id, field, val) => setModes(modes.map(m => m.id === id ? { ...m, [field]: parseFloat(val) || 0 } : m));
  const addMode = () => setModes([...modes, { id: Date.now(), shift: 1000, strength: 0.5, t2: 5 }]);
  const removeMode = (id) => setModes(modes.filter(m => m.id !== id));

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      <header className="bg-white border-b px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Atom className="text-blue-600 w-6 h-6" />
          <h1 className="text-xl font-bold tracking-tight">Simulador fs-CARS & FAST-CARS</h1>
          {isCalculating && (
            <div className="flex items-center gap-1.5 bg-amber-50 text-amber-600 px-3 py-1 rounded-full text-xs font-bold border border-amber-200 shadow-sm">
              <Loader2 className="w-3 h-3 animate-spin" />
              Calculando...
            </div>
          )}
        </div>
        <div className="text-sm text-slate-500 font-medium">Modelo Impulsivo en Dominio Temporal</div>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col md:flex-row">
        <aside className="w-full md:w-96 bg-white border-r overflow-y-auto p-6 space-y-8 shadow-inner">
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Settings2 className="w-5 h-5 text-slate-400" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Parámetros Láser</h2>
            </div>
            {Object.entries(lasers).map(([name, params]) => (
              <div key={name} className="mb-6 bg-slate-50 p-4 rounded-xl border border-slate-100">
                <h3 className="text-sm font-bold capitalize mb-3 text-blue-700">Pulso {name === 'pump' ? 'de Bombeo (Pump)' : name === 'stokes' ? 'Stokes' : 'Sonda (Probe)'}</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400">λ (nm)</label>
                  <input type="number" value={params.lam} onChange={(e) => updateLaser(name, 'lam', e.target.value)} className="w-full px-2 py-1 text-sm rounded border border-slate-200" /></div>
                  <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400">FWHM (fs)</label>
                  <input type="number" value={params.fwhm} onChange={(e) => updateLaser(name, 'fwhm', e.target.value)} className="w-full px-2 py-1 text-sm rounded border border-slate-200" /></div>
                  <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400">Delay (fs)</label>
                  <input type="number" value={params.delay} onChange={(e) => updateLaser(name, 'delay', e.target.value)} className="w-full px-2 py-1 text-sm rounded border border-slate-200" /></div>
                </div>
              </div>
            ))}
          </section>

          <section>
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-5 h-5 text-slate-400" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Procesamiento</h2>
            </div>
            <div className="bg-white p-4 border rounded-xl shadow-sm flex items-center justify-between hover:bg-slate-50 transition-colors cursor-pointer" onClick={() => setNormalize(!normalize)}>
              <div>
                <span className="text-sm font-bold text-slate-700 block">Normalizar por Perfil</span>
                {/* CORRECCIÓN: Texto más riguroso respecto a la física subyacente */}
                <span className="text-xs text-slate-500">Compensa el perfil de batido (beating)</span>
              </div>
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} className="accent-blue-600 w-5 h-5 pointer-events-none" />
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2"><Beaker className="w-5 h-5 text-slate-400" /><h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Resonancias Raman</h2></div>
              <button onClick={addMode} className="p-1 hover:bg-blue-50 text-blue-600 rounded-full transition-colors"><Plus className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              {modes.map((mode) => (
                <div key={mode.id} className="p-3 bg-white border rounded-lg shadow-sm">
                  <div className="flex items-center justify-between mb-2"><span className="text-xs font-bold text-slate-400">Modo</span>
                  <button onClick={() => removeMode(mode.id)} className="text-slate-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button></div>
                  <div className="grid grid-cols-3 gap-2">
                    <input type="number" value={mode.shift} onChange={(e) => updateMode(mode.id, 'shift', e.target.value)} className="w-full px-1 py-1 text-xs border rounded" placeholder="Shift" />
                    <input type="number" step="0.1" value={mode.strength} onChange={(e) => updateMode(mode.id, 'strength', e.target.value)} className="w-full px-1 py-1 text-xs border rounded" placeholder="Fuerza" />
                    <input type="number" value={mode.t2} onChange={(e) => updateMode(mode.id, 't2', e.target.value)} className="w-full px-1 py-1 text-xs border rounded" placeholder="T2" />
                  </div>
                </div>
              ))}
              <div className="pt-4 border-t">
                 <div className="flex justify-between items-center mb-2">
                   <label className="text-xs font-bold text-slate-500">Fondo No Resonante (NRB)</label>
                   <span className="text-xs font-mono text-blue-600 bg-blue-50 px-2 py-1 rounded">{nrb.toFixed(2)}</span>
                 </div>
                 <input type="range" min="0" max="2" step="0.05" value={nrb} onChange={(e) => setNrb(parseFloat(e.target.value))} className="w-full accent-blue-600" />
              </div>
            </div>
          </section>
        </aside>

        <section className="flex-1 p-6 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-sm border p-4 mb-6">
            <div className="flex gap-4 border-b mb-6 overflow-x-auto">
              {['fast-cars-spectrum', 'spectrum', 'pulses'].map(tab => (
                <button 
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`pb-3 px-2 text-sm font-bold whitespace-nowrap transition-colors ${activeTab === tab ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {tab === 'spectrum' ? 'Espectro fs-CARS' : tab === 'pulses' ? 'Perfiles de Pulso (Tiempo)' : 'Espectro FAST-CARS'}
                </button>
              ))}
            </div>

            <div className="h-[500px] w-full">
              {activeTab === 'spectrum' && (
                <Plot
                  data={[{ x: simulation.shiftAxis, y: simulation.carsIntensity, type: 'scatter', mode: 'lines', name: 'Intensidad fs-CARS', line: { color: '#2563eb', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(37, 99, 235, 0.1)' }]}
                  layout={{ 
                    autosize: true, 
                    title: 'Espectro fs-CARS Convencional (Probe Fijo)', 
                    xaxis: { title: { text: 'Raman Shift (cm⁻¹)' }, automargin: true }, 
                    yaxis: { title: { text: 'Intensidad (u.a.)' }, automargin: true }, 
                    margin: { l: 80, r: 20, t: 50, b: 80 } 
                  }}
                  config={{ responsive: true, displayModeBar: false }}
                  style={{ width: '100%', height: '100%' }}
                />
              )}
              {activeTab === 'pulses' && (
                <Plot
                  data={[
                    { x: simulation.pulseTime, y: simulation.pumpInt, type: 'scatter', mode: 'lines', name: 'Pump (Bombeo)', line: { color: '#2563eb', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(37, 99, 235, 0.2)' },
                    { x: simulation.pulseTime, y: simulation.stokesInt, type: 'scatter', mode: 'lines', name: 'Stokes', line: { color: '#ef4444', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(239, 68, 68, 0.2)' },
                    { x: simulation.pulseTime, y: simulation.probeInt, type: 'scatter', mode: 'lines', name: 'Probe (Sonda)', line: { color: '#10b981', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(16, 185, 129, 0.2)' }
                  ]}
                  layout={{ 
                    autosize: true, 
                    title: 'Perfiles Temporales de los Pulsos Láser', 
                    xaxis: { title: { text: 'Tiempo (fs)' }, range: [-300, 300], automargin: true },
                    yaxis: { title: { text: 'Intensidad Normalizada' }, automargin: true }, 
                    margin: { l: 80, r: 20, t: 50, b: 80 },
                    legend: { orientation: 'h', y: 1.1, x: 0.5, xanchor: 'center' }
                  }}
                  config={{ responsive: true, displayModeBar: true }}
                  style={{ width: '100%', height: '100%' }}
                />
              )}
              {activeTab === 'fast-cars-spectrum' && (
                <Plot
                  data={[
                    { x: simulation.shiftAxis, y: simulation.excProfileNorm, type: 'scatter', mode: 'lines', name: 'Perfil de Batido', line: { color: '#94a3b8', width: 2, dash: 'dash' }, fill: 'tozeroy', fillcolor: 'rgba(148, 163, 184, 0.1)' },
                    { x: simulation.shiftAxis, y: simulation.fastCarsSpecNorm, type: 'scatter', mode: 'lines', name: 'Intensidad FAST-CARS', line: { color: '#ef4444', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(239, 68, 68, 0.1)' }
                  ]}
                  layout={{ 
                    autosize: true, 
                    title: normalize ? 'Espectro Raman FAST-CARS (Deconvolucionado)' : 'Espectro Raman FAST-CARS Crudo', 
                    xaxis: { title: { text: 'Raman Shift (cm⁻¹)' }, range: [0, 3500], automargin: true }, 
                    yaxis: { title: { text: 'Intensidad Normalizada (u.a.)' }, automargin: true }, 
                    margin: { l: 80, r: 20, t: 50, b: 80 },
                    legend: { orientation: 'h', y: 1.1, x: 0.5, xanchor: 'center' }
                  }}
                  config={{ responsive: true, displayModeBar: false }}
                  style={{ width: '100%', height: '100%' }}
                />
              )}
            </div>
          </div>

          <div className="bg-blue-900/10 border border-blue-200 p-5 rounded-2xl">
            <div className="flex items-center gap-2 mb-3 text-blue-900 font-bold">
              <Info className="w-5 h-5" />
              <h4 className="uppercase text-xs tracking-widest">Física del Experimento FAST-CARS</h4>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm leading-relaxed text-slate-700">
              <div className="space-y-2">
                <p>
                  <strong>Preparación de la Coherencia:</strong> En el límite impulsivo, la combinación de los pulsos <em>Pump</em> y <em>Stokes</em> excita instantáneamente una coherencia vibracional. Esta coherencia evoluciona como un oscilador amortiguado <span className="font-serif whitespace-nowrap text-[1.05rem]"><em>χ</em><sup>(3)</sup>(<em>t</em>) ∝ <em>e</em><sup>−<em>t</em>/<em>T</em><sub>2</sub></sup> sin(<em>Ωt</em>)</span>.
                </p>
                <p>
                  <strong>Relajación <span className="font-serif text-[1.05rem]"><em>T</em><sub>2</sub></span>:</strong> El tiempo de decaimiento transversal determina el ancho de línea espectral. Un <span className="font-serif text-[1.05rem]"><em>T</em><sub>2</sub></span> largo produce picos estrechos y definidos tras la Transformada de Fourier.
                </p>
              </div>
              <div className="space-y-2">
                <p>
                  <strong>Supresión del NRB:</strong> El fondo no resonante ocurre solo cuando los pulsos de excitación y sonda se solapan en el tiempo. Al escanear la sonda, FAST-CARS extrae la señal limpia donde el NRB ya se ha extinguido.
                </p>
                <p>
                  <strong>Perfil de Excitación:</strong> La intensidad medida es el producto de las resonancias de la muestra y el <strong>perfil de energía de batido (beating)</strong> del láser. Para obtener las fuerzas relativas puras, se divide el espectro crudo por este perfil.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER DE CRÉDITOS */}
      <footer className="bg-white border-t px-6 py-3 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400 font-medium z-10">
        <div>&copy; 2026 - OCalderonL</div>
        <div className="flex items-center gap-1 mt-1 sm:mt-0">
          Powered with <span className="text-red-500 animate-pulse">❤️</span> by Gemini
        </div>
      </footer>
    </div>
  );
};

export default App;

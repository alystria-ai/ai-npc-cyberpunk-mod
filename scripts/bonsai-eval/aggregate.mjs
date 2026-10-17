import {readFile, readdir} from 'node:fs/promises';
const W = 'E:/CyberpunkConvai-offload/work/bonsai-eval/results/step1';
const med = a => { a = a.filter(x => x != null && x >= 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const p90 = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)]; };
const order = ['gemma4-e4b','q35-2b','bonsai2-9b','bonsai2-4b','bonsai2-2b'];
for (const label of order) {
  const d = JSON.parse(await readFile(`${W}/${label}.json`, 'utf8'));
  const R = d.results;
  const st = R.filter(r => r.layout === 'stable'), ms = R.filter(r => r.layout === 'mistral');
  const warm = rs => rs.filter(r => r.turn > 1);
  const reuse = rs => { const a = rs.filter(r => r.cacheN != null && r.promptN != null); return a.reduce((s, r) => s + r.cacheN, 0) / a.reduce((s, r) => s + r.cacheN + r.promptN, 0); };
  console.log(`\n== ${label}  load ${d.loadMs}ms VRAM ${d.vramBefore}->${d.vramLoaded} (peak ${d.vramPeak}) added ${d.vramPeak - d.vramBefore} MiB, rss ${d.serverRssMiB}`);
  console.log(` hw: gpuPowerMax ${d.hw.gpuPowerMax}W meanBusy ${d.hw.gpuPowerMeanWhenBusy}W clockMax ${d.hw.gpuClockMax} tempMax ${d.hw.gpuTempMax} cpuPerf max ${d.hw.cpuPerfMax?.toFixed(0)} mean ${d.hw.cpuPerfMean}`);
  for (const [name, rs] of [['stable run1', st.filter(r => r.run === 1)], ['stable run2', st.filter(r => r.run === 2)], ['mistral', ms]]) {
    const w = warm(rs), first = rs.filter(r => r.turn === 1);
    console.log(` ${name.padEnd(12)} TTFT turn1 med ${med(first.map(r => r.ttftMs))} | warm TTFT med ${med(w.map(r => r.ttftMs))} p90 ${p90(w.map(r => r.ttftMs))} | total med(warm) ${med(w.map(r => r.totalMs))} p90 ${p90(w.map(r => r.totalMs))} | tps ${mean(rs.map(r => r.genTps).filter(Boolean))?.toFixed(0)} | new tokens warm med ${med(w.map(r => r.promptN))} | reuse(warm) ${(reuse(w) * 100).toFixed(0)}% reuse(all) ${(reuse(rs) * 100).toFixed(0)}% | gen tokens med ${med(rs.map(r => r.genN))}`);
  }
  const fl = {}; for (const r of st) for (const f of r.flags) fl[f] = (fl[f] ?? 0) + 1;
  console.log(` flags (stable, ${st.length} replies):`, JSON.stringify(fl));
  const fm = {}; for (const r of ms) for (const f of r.flags) fm[f] = (fm[f] ?? 0) + 1;
  console.log(` flags (mistral layout, ${ms.length}):`, JSON.stringify(fm));
  const mx = st.reduce((a, r) => Math.max(a, r.totalMs), 0); console.log(` max total ${mx}ms; errors ${R.filter(r => r.error).length}; tags used ${st.filter(r => /[{\[]/.test(r.raw ?? '')).length}`);
}

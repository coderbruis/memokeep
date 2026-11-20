// Synthetic JS coordinator + actual Tauri bridge; the IPC transport is in-memory.
// Run Rust's synthetic_record_storage_benchmark separately for real SQLite I/O.
const { performance } = require('node:perf_hooks');
const { recordFixture, bytes } = require('./fixtures/record-save.cjs');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function sample(count, records, measureCopies = false) {
  const h = recordFixture({ count, enabled: records });
  const original = globalThis.structuredClone;
  let cloneInputBytes = 0, cloneCalls = 0;
  if (measureCopies) globalThis.structuredClone = value => { cloneCalls++; cloneInputBytes += bytes(value); return original(value); };
  const timer = performance.now();
  try { await h.saving[records ? 'transactNote' : 'transact'](data => { data.documents[0].title = 'synthetic edit'; }); }
  finally { globalThis.structuredClone = original; }
  return { elapsedMs: performance.now() - timer, ipcBytes: h.calls.reduce((sum, row) => sum + row.requestBytes + row.responseBytes, 0),
    cloneCalls, cloneInputBytes, commands: h.calls.map(row => row.name) };
}

(async () => {
  const results = [];
  for (const count of [1000, 10000]) {
    const result = { notes: count, samples: 5, noteBody: 'synthetic Chinese text', transport: 'in-memory IPC fixture; actual coordinator and bridge' };
    for (const [name, enabled] of [['fieldSnapshot', false], ['record', true]]) {
      await sample(count, enabled); // Warm compilation/VM code separately from the reported samples.
      const samples = [];
      for (let run = 0; run < 5; run++) samples.push(await sample(count, enabled));
      const measured = await sample(count, enabled, true);
      result[name] = { saveMedianMs: +median(samples.map(row => row.elapsedMs)).toFixed(3), ipcBytes: measured.ipcBytes,
        cloneInputBytes: measured.cloneInputBytes, cloneCalls: measured.cloneCalls, commands: measured.commands };
    }
    results.push(result);
  }
  console.log(JSON.stringify({ benchmark: 'record-save', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

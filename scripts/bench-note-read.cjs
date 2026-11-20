// Counts actual bridge/adapter payloads using synthetic in-memory IPC, not GUI or SQLite latency.
// Run: node --expose-gc core/scripts/bench-note-read.cjs
const { recordFixture, bytes } = require('./fixtures/record-save.cjs');

async function sample(count, enabled, knownRevision) {
  const h = recordFixture({ count, enabled });
  const largeBody = 'synthetic large note '.repeat(50000);
  h.remote().documents[0].content = largeBody;
  h.remote().documents[0].metadata.noteContent = `<p>${largeBody}</p>`;
  h.remote().documents[0].metadata.versions = [{ title: 'synthetic previous version', content: largeBody }];
  h.state.data.documents[0] = structuredClone(h.remote().documents[0]);
  h.state.baseline.documents[0] = structuredClone(h.remote().documents[0]);
  // Initial loading/preparation is excluded, just as when reopening an already loaded note.
  await h.storage.readNoteRecord('documents', 'note-1');
  const initialCalls = h.calls.length, originalClone = globalThis.structuredClone;
  let cloneInputBytes = 0, unchanged = 0;
  globalThis.structuredClone = value => { cloneInputBytes += bytes(value); return originalClone(value); };
  try {
    for (let index = 0; index < 30; index++) {
      const result = await h.storage.readNoteRecord('documents', 'note-0', knownRevision);
      if (result?.unchanged) unchanged++;
    }
  } finally { globalThis.structuredClone = originalClone; }
  const calls = h.calls.slice(initialCalls);
  return { opens: 30, noteBytes: bytes(h.remote().documents[0]), unchanged,
    commands: calls.reduce((counts, row) => { counts[row.name] = (counts[row.name] || 0) + 1; return counts; }, {}),
    requestBytes: calls.reduce((sum, row) => sum + row.requestBytes, 0),
    responseBytes: calls.reduce((sum, row) => sum + row.responseBytes, 0),
    syntheticIpcCloneInputBytes: cloneInputBytes };
}

(async () => {
  const results = [];
  for (const notes of [1000, 10000]) {
    const row = { notes };
    for (const [name, enabled, known] of [['v4Unconditional', true, null], ['v4KnownRevision', true, 1], ['v3KnownRevision', false, 1]]) {
      row[name] = await sample(notes, enabled, known);
      globalThis.gc?.();
    }
    results.push(row);
  }
  console.log(JSON.stringify({ benchmark: 'already-loaded-large-note-reopen',
    scope: 'Actual JS adapter/bridge; synthetic IPC copies; excludes startup, DOM, editor setup and database latency.', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

const { parentPort, workerData } = require('node:worker_threads');

parentPort.on('message', ({ requestId, query }) => {
  const matches = [];
  for (let id = 1; id <= workerData.initialCount; id += 1) {
    if (String(id).includes(query)) matches.push(id);
  }
  const ids = Uint32Array.from(matches);
  // Передаём буфер потоку сервера без копирования массива найденных ID.
  parentPort.postMessage({ requestId, ids }, [ids.buffer]);
});

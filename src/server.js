const { createApp } = require('./app');

const { app, close } = createApp();
const server = app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
  console.log(`Million Items Board: http://localhost:${server.address().port}`);
});

function shutdown() {
  close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

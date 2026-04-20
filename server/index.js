/**
 * Local dev entry point. On Vercel, `api/index.js` is used instead and this
 * file is not executed.
 */
import { buildApp, connectMongoOnce } from './app.js';

const PORT = process.env.PORT || 5000;

connectMongoOnce();

const app = buildApp();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

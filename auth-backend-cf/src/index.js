// Entry point of the Worker (wrangler.toml: main). Backup for auth-backend/ (Vercel): the same API, see README.md.
import { createApp } from './app.js';

export { StateDO, ErrorsDO } from './do.js';

const handle = createApp();

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};

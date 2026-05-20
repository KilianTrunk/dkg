// Companion fixture for plugin-routes-api e2e: re-exports the
// `throwingPlugin` from index.js as the default so the daemon's
// plugin-loader picks it up as a standalone spec alongside the echo
// fixture in a two-entry `routePlugins` config.
import { throwingPlugin } from './index.js';
export default throwingPlugin;

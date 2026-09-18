import base from './packages/config/eslint.config.mjs';
import web from './apps/web/eslint.config.mjs';

export default [...base, ...web];

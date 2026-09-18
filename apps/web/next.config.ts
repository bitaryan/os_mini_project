import type { NextConfig } from 'next';
import { readWebEnv } from './lib/env';

readWebEnv();

const config: NextConfig = { poweredByHeader: false };
export default config;

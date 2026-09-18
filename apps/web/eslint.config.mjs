import next from 'eslint-config-next/core-web-vitals';

export default next.map((config) => ({
  ...config,
  files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
  settings: { ...config.settings, next: { rootDir: 'apps/web/' } },
}));

const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const distDir = join(__dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });

const pkgPath = join(distDir, 'package.json');
const contents = {
  type: 'commonjs'
};

writeFileSync(pkgPath, `${JSON.stringify(contents, null, 2)}\n`);

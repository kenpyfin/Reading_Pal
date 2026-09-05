const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolveBuildId() {
  if (process.env.REACT_APP_BUILD_ID) {
    return process.env.REACT_APP_BUILD_ID.replace(/[^a-zA-Z0-9._-]/g, '-');
  }
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (_error) {
    return `dev-${Date.now()}`;
  }
}

const buildId = resolveBuildId();
const root = path.resolve(__dirname, '..');
const templatePath = path.join(__dirname, 'sw.template.js');
const swPath = path.join(root, 'public', 'sw.js');
const envPath = path.join(root, '.env.production.local');

const template = fs.readFileSync(templatePath, 'utf8');
const swSource = template.replace(/__BUILD_ID__/g, buildId);
fs.writeFileSync(swPath, swSource);

const envLine = `REACT_APP_BUILD_ID=${buildId}`;
if (fs.existsSync(envPath)) {
  const existing = fs.readFileSync(envPath, 'utf8');
  if (existing.includes('REACT_APP_BUILD_ID=')) {
    fs.writeFileSync(
      envPath,
      existing.replace(/^REACT_APP_BUILD_ID=.*$/m, envLine)
    );
  } else {
    fs.writeFileSync(envPath, `${existing.trimEnd()}\n${envLine}\n`);
  }
} else {
  fs.writeFileSync(envPath, `${envLine}\n`);
}

console.log(`[inject-sw-build-id] BUILD_ID=${buildId}`);

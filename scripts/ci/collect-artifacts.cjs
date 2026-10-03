const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { layout, metadata } = require('./build-info.cjs');

const build = layout();
const info = metadata();
const output = path.join(build.root, 'out/releases');
fs.mkdirSync(output, { recursive: true });
const prefix = `MusicFree-${info.version}-${info.platform}-${info.arch}`;
const artifacts = [];
function copy(source, suffix) {
    const destination = path.join(output, prefix + suffix);
    if (fs.existsSync(destination)) throw new Error('Refusing to overwrite ' + destination);
    fs.copyFileSync(source, destination);
    artifacts.push(destination);
}
if (build.platform === 'win32') {
    copy(path.join(build.root, 'out/make/squirrel.windows', build.arch, 'MusicFreeSetup.exe'), '-setup.exe');
    // Installers were created before adding the portable data marker.
    fs.mkdirSync(path.join(build.directory, 'portable'), { recursive: true });
    const archive = path.join(output, prefix + '-portable.zip');
    execFileSync('python', [path.join(__dirname, 'archive.py'), build.directory, archive], { stdio: 'inherit' });
    artifacts.push(archive);
} else if (build.platform === 'darwin') {
    copy(path.join(build.root, 'out/make', `MusicFree-${info.version}-${build.arch}.dmg`), '.dmg');
    const zipDir = path.join(build.root, 'out/make/zip/darwin', build.arch);
    const zips = fs.readdirSync(zipDir).filter(file => file.endsWith('.zip'));
    if (zips.length !== 1) throw new Error('Expected exactly one macOS application ZIP');
    copy(path.join(zipDir, zips[0]), '.zip');
} else if (build.platform === 'linux') {
    const debDir = path.join(build.root, 'out/make/deb', build.arch);
    const debs = fs.readdirSync(debDir).filter(file => file.endsWith('.deb'));
    if (debs.length !== 1) throw new Error('Expected exactly one Debian package');
    copy(path.join(debDir, debs[0]), '.deb');
    const archive = path.join(output, prefix + '.tar.gz');
    if (fs.existsSync(archive)) throw new Error('Refusing to overwrite ' + archive);
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(build.directory), path.basename(build.directory)]);
    artifacts.push(archive);
} else throw new Error('Unsupported release platform: ' + build.platform);

const hashes = artifacts.map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`);
fs.writeFileSync(path.join(output, `SHA256SUMS-${info.platform}-${info.arch}.txt`), hashes.join('\n') + '\n');
fs.writeFileSync(path.join(output, `build-info-${info.platform}-${info.arch}.json`), JSON.stringify({
    ...info, artifacts: artifacts.map(file => path.basename(file)),
    verification: JSON.parse(fs.readFileSync(path.join(build.root, 'out/ci-test-results/package-runtime.json'), 'utf8')),
}, null, 2) + '\n');
console.log('Collected ' + artifacts.length + ' release files for ' + info.platform + '/' + info.arch);

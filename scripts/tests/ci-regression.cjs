const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'musicfree-ci-regression-'));
function load(name, mocks = {}, host = process) {
    const filename = path.join(root, 'scripts/ci', name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: name => name in mocks ? mocks[name] : require(name), module, exports: module.exports,
        __dirname: path.dirname(filename), process: host, console,
    }, { filename });
    return module.exports;
}
try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ productName: 'MusicFree', version: '1.2.3' }));
    const helpers = (platform, arch, env = {}) => load('build-info.cjs', {
        'node:child_process': { execFileSync: () => 'verified-commit\n' },
    }, { ...process, platform, arch, env });
    for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
        const info = helpers(platform, arch);
        const layout = info.layout(fixture);
        assert.equal(layout.directory, path.join(fixture, 'out', `MusicFree-${platform}-${arch}`));
        assert.equal(layout.resources, path.join(layout.directory, platform === 'darwin' ? 'MusicFree.app/Contents/Resources' : 'resources'));
        assert.equal(info.metadata(fixture).commit, 'verified-commit');
    }
    assert.throws(() => helpers('win32', 'x64', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' }).metadata(fixture), /does not match/);
    assert.equal(helpers('win32', 'x64', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' }).metadata(fixture).tag, 'v1.2.3');
    const info = helpers('win32', 'x64');
    const app = info.layout(fixture).directory;
    fs.mkdirSync(path.join(app, '.webpack/renderer'), { recursive: true });
    fs.writeFileSync(path.join(app, '.webpack/renderer/index.js'), 'bundle');
    fs.writeFileSync(path.join(app, 'MusicFree.exe'), 'test executable');
    fs.mkdirSync(path.join(fixture, 'out/make/squirrel.windows/x64'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'out/make/squirrel.windows/x64/MusicFreeSetup.exe'), 'test installer');
    fs.mkdirSync(path.join(fixture, 'out/ci-test-results'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'out/ci-test-results/package-runtime.json'), JSON.stringify({ passed: true }));
    const helperMock = { layout: () => info.layout(fixture), metadata: () => info.metadata(fixture) };
    load('collect-artifacts.cjs', { './build-info.cjs': helperMock });
    const archive = path.join(fixture, 'out/releases/MusicFree-1.2.3-win32-x64-portable.zip');
    execFileSync('python', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert "MusicFree-win32-x64/portable/" in z.namelist(); assert z.read("MusicFree-win32-x64/.webpack/renderer/index.js")==b"bundle"', archive]);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'out/releases/build-info-win32-x64.json'), 'utf8'));
    assert.equal(manifest.artifacts.length, 2);
    const hash = fs.readFileSync(path.join(fixture, 'out/releases/SHA256SUMS-win32-x64.txt'), 'utf8');
    assert.equal(hash.trim().split('\n').length, 2);
    for (const line of hash.trim().split('\n')) {
        const [digest, filename] = line.split('  ');
        assert.equal(digest, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(fixture, 'out/releases', filename))).digest('hex'));
    }
    assert.throws(() => load('collect-artifacts.cjs', { './build-info.cjs': helperMock }), /overwrite/);
    // macOS image creation keeps the app tree and an Applications drag target.
    const macBuild = helpers('darwin', 'arm64').layout(fixture);
    fs.mkdirSync(path.join(macBuild.directory, 'MusicFree.app/Contents'), { recursive: true });
    fs.writeFileSync(path.join(macBuild.directory, 'MusicFree.app/Contents/test'), 'mac application');
    const dmgCommands = [];
    load('create-dmg.cjs', {
        './build-info.cjs': { layout: () => macBuild },
        'node:child_process': { execFileSync: (command, args) => {
            dmgCommands.push([command, ...args]);
            if (command === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
            else if (args[0] === 'create') {
                const staging = args[args.indexOf('-srcfolder') + 1];
                assert.equal(fs.readFileSync(path.join(staging, 'MusicFree.app/Contents/test'), 'utf8'), 'mac application');
                assert.equal(fs.readFileSync(path.join(staging, 'Applications'), 'utf8'), '/Applications');
                fs.writeFileSync(args.at(-1), 'test image');
            }
        } },
        'node:fs': { ...fs, symlinkSync: (target, file) => fs.writeFileSync(file, target),
            readlinkSync: file => fs.readFileSync(file, 'utf8') },
    });
    assert.deepEqual(dmgCommands.map(args => args[0]), ['ditto', 'hdiutil', 'hdiutil']);
    assert.ok(dmgCommands[1].includes('HFS+'));
    assert.equal(dmgCommands[2][1], 'verify');
    // Simulate GitHub CLI responses without creating releases or contacting GitHub.
    const releaseRoot = path.join(fixture, 'out/releases');
    for (const target of ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64']) {
        const [platform, arch] = target.split('-');
        fs.writeFileSync(path.join(releaseRoot, 'build-info-' + target + '.json'), JSON.stringify({
            version: '1.2.3', platform, arch, commit: 'same-commit', verification: { passed: true }, artifacts: ['test.deb'],
        }));
    }
    fs.writeFileSync(path.join(releaseRoot, 'test.deb'), 'package');
    const releaseFs = { ...fs, readdirSync: () => ['test.deb'], readFileSync: file => fs.readFileSync(path.join(releaseRoot, path.basename(file)), 'utf8'),
        statSync: file => fs.statSync(path.join(releaseRoot, path.basename(file))) };
    for (const state of ['new', 'draft', 'published']) {
        const calls = [];
        const execute = () => load('create-release.cjs', {
            'node:fs': releaseFs,
            'node:child_process': { spawnSync: (_command, args) => {
                calls.push(args);
                return args[1] === 'view' ? { status: state === 'new' ? 1 : 0, stdout: JSON.stringify({ isDraft: state === 'draft' }) }
                    : { status: 0, stdout: '' };
            } },
        }, { ...process, env: { RELEASE_TAG: 'v1.2.3', GITHUB_REPOSITORY: 'test/repo' } });
        if (state === 'published') {
            assert.throws(execute, /published release/);
            assert.equal(calls.length, 1);
        } else {
            execute();
            assert.equal(calls.some(args => args[1] === 'create'), state === 'new');
            assert.equal(calls.at(-1)[1], 'upload');
            if (state === 'new') assert.ok(calls.find(args => args[1] === 'create').includes('--draft'));
        }
    }
    console.log('PASS: four-platform paths, version tag guard, checksums, portable marker and hidden resources, overwrite guard, draft release creation/rerun and published release protection');
} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

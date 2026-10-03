const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tag = process.env.RELEASE_TAG;
if (!tag || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Expected a version tag');
const directory = path.resolve('out/releases');
const targets = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
let commit;
for (const target of targets) {
    const info = JSON.parse(fs.readFileSync(path.join(directory, `build-info-${target}.json`), 'utf8'));
    if (tag !== 'v' + info.version || `${info.platform}-${info.arch}` !== target || !info.verification.passed) {
        throw new Error('Invalid build metadata for ' + target);
    }
    if (commit && info.commit !== commit) throw new Error('Release artifacts refer to different commits');
    commit = info.commit;
    for (const file of info.artifacts) {
        if (path.basename(file) !== file || !fs.statSync(path.join(directory, file)).size) throw new Error('Invalid artifact ' + file);
    }
}
function gh(args) {
    const result = spawnSync('gh', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
}
const repository = process.env.GITHUB_REPOSITORY;
const existing = gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft']);
if (existing.status === 0) {
    if (!JSON.parse(existing.stdout).isDraft) throw new Error('Refusing to replace artifacts of a published release');
} else {
    const create = gh(['release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--generate-notes',
        '--title', tag, ...(tag.includes('-') ? ['--prerelease'] : [])]);
    if (create.status !== 0) throw new Error(create.stderr);
}
const files = fs.readdirSync(directory).filter(file => /\.(?:zip|exe|deb|dmg|gz|txt|json)$/.test(file)).map(file => path.join(directory, file));
const upload = gh(['release', 'upload', tag, ...files, '--repo', repository, '--clobber']);
if (upload.status !== 0) throw new Error(upload.stderr);
console.log('Created or updated draft release ' + tag);

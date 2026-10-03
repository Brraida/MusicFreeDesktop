const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function layout(root = path.resolve(__dirname, '../..')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const platform = process.platform, arch = process.arch;
    const name = pkg.productName;
    const directory = path.join(root, 'out', `${name}-${platform}-${arch}`);
    const resources = platform === 'darwin'
        ? path.join(directory, name + '.app/Contents/Resources') : path.join(directory, 'resources');
    const executable = platform === 'darwin' ? path.join(directory, name + '.app/Contents/MacOS', name)
        : path.join(directory, name + (platform === 'win32' ? '.exe' : ''));
    return { root, pkg, platform, arch, directory, resources, executable };
}

function metadata(root = path.resolve(__dirname, '../..')) {
    const { pkg, platform, arch } = layout(root);
    const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
    if (tag && tag !== 'v' + pkg.version) {
        throw new Error(`Release tag ${tag} does not match package.json version v${pkg.version}`);
    }
    return { version: pkg.version, platform, arch, tag,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        builtAt: new Date().toISOString(),
        runUrl: process.env.GITHUB_RUN_ID
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
    };
}

module.exports = { layout, metadata };
if (require.main === module) {
    const info = metadata();
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${info.version}\n`);
    console.log(JSON.stringify(info, null, 2));
}

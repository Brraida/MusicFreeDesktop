/* Exercise shipped startup hooks and real Windows Shell links with a unique test identity. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { layout } = require("../ci/build-info.cjs");
assert.equal(process.platform, "win32");
const root = path.resolve(__dirname, "../..");
const source = path.resolve(process.argv[2] || layout().directory);
const vendor = path.join(path.dirname(require.resolve("electron-winstaller/package.json")), "vendor");
const rcedit = path.join(path.dirname(require.resolve("rcedit/package.json")), "bin/rcedit-x64.exe");
const id = "MusicFreeShortcutTest" + process.pid + Date.now();
const fixture = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, id + " 安装 with spaces "));
const title = path.basename(fixture);
const version = require("electron-winstaller").convertVersion(JSON.parse(fs.readFileSync(path.join(source, "resources/app/package.json"), "utf8")).version);
const installed = path.join(fixture, "app-" + version);
const updater = path.join(fixture, "Update.exe");
const executable = path.join(installed, "MusicFree.exe");
const packages = path.join(fixture, "packages");
const output = path.join(root, "out/ci-test-results");
fs.mkdirSync(output, { recursive: true });
const operations = [];
const menuGroups = new Set();
let checked;
function run(command, args, timeout = 30000) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
    assert(!result.error, result.error?.message);
    assert.equal(result.status, 0, (result.stdout || "") + (result.stderr || ""));
    return result.stdout;
}
function probe() {
    const file = path.join(fixture, "shortcut-observation.json");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
        path.join(__dirname, "windows-shortcut-probe.ps1"), "-Title", title, "-OutputFile", file]);
    run(require("electron"), [path.join(__dirname, "windows-shortcut-reader.cjs"), file]);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}
function assertLinks(expected) {
    checked = probe();
    for (const link of checked.startMenu) menuGroups.add(path.dirname(link.path));
    for (const location of ["desktop", "startMenu"]) {
        assert.equal(checked[location].length, expected, location + " shortcut count");
        for (const link of checked[location]) {
            assert(fs.existsSync(link.target), "Shortcut target must exist: " + JSON.stringify({ fixture, link }));
            // GitHub Windows runners may expose LOCALAPPDATA through an 8.3
            // alias (RUNNER~1), while the Shell returns the equivalent long path.
            const canonicalRoot = fs.realpathSync.native(fixture).toLowerCase();
            const canonicalTarget = fs.realpathSync.native(link.target).toLowerCase();
            const relative = path.relative(canonicalRoot, canonicalTarget);
            assert(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
                "Shortcut target outside fixture: " + JSON.stringify({ fixture, target: link.target, canonicalRoot, canonicalTarget }));
        }
    }
}
try {
    assertLinks(0);
    fs.cpSync(source, installed, { recursive: true, filter: file => path.basename(file) !== "portable" });
    run(rcedit, [executable, "--set-version-string", "ProductName", title,
        "--set-version-string", "FileDescription", title, "--set-version-string", "CompanyName", id]);
    fs.copyFileSync(path.join(vendor, "Squirrel.exe"), updater);
    fs.copyFileSync(path.join(vendor, "StubExecutable.exe"), path.join(fixture, "MusicFree.exe"));
    const appRoot = path.join(installed, "resources/app");
    const pkgFile = path.join(appRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    assert.equal(pkg.main, ".webpack/main");
    // Keep the shipped bundle intact. Guards fail if an installation event enters
    // normal startup, before it can change protocols, user data or the instance lock.
    const entry = ".squirrel-hook-probe.cjs";
    fs.writeFileSync(path.join(appRoot, entry), `const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const profile=path.join(__dirname,'../../guard-profile');fs.mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);app.setPath('appData',profile);
for(const method of ['setAsDefaultProtocolClient','requestSingleInstanceLock','whenReady']) {
 app[method]=()=>{throw new Error('Installation event entered normal startup: '+method)};
}
app.on('browser-window-created',()=>{throw new Error('Installation event created a player window')});
require('./.webpack/main');
`);
    fs.writeFileSync(pkgFile, JSON.stringify({ ...pkg, name: id, main: entry }));
    fs.mkdirSync(packages);
    fs.writeFileSync(path.join(fixture, "placeholder.txt"), "Shortcut metadata fixture");
    const nuspec = path.join(fixture, id + ".nuspec");
    fs.writeFileSync(nuspec, `<?xml version="1.0"?><package><metadata><id>${id}</id><version>${version}</version>
<title>${title}</title><authors>${id}</authors><description>Isolated shortcut regression</description>
<requireLicenseAcceptance>false</requireLicenseAcceptance></metadata>
<files><file src="placeholder.txt" target="lib/net45" /></files></package>`);
    run(path.join(vendor, "nuget.exe"), ["pack", nuspec, "-BasePath", fixture, "-OutputDirectory", packages, "-NoDefaultExcludes", "-NonInteractive"]);
    const created = fs.readdirSync(packages).find(name => name.endsWith(".nupkg"));
    assert(created);
    const archive = id + "-" + version + "-full.nupkg";
    fs.renameSync(path.join(packages, created), path.join(packages, archive));
    const data = fs.readFileSync(path.join(packages, archive));
    fs.writeFileSync(path.join(packages, "RELEASES"), crypto.createHash("sha1").update(data).digest("hex") + " " + archive + " " + data.length + "\r\n");
    for (const event of ["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall", "--squirrel-obsolete"]) {
        run(executable, [event, version], 20000);
        assertLinks(event === "--squirrel-install" || event === "--squirrel-updated" ? 1 : 0);
        operations.push(event);
    }
    console.log("PASS: shipped Windows entry and actual Squirrel updater create/update/remove desktop and Start Menu links; no player, protocol or instance-lock startup");
    fs.writeFileSync(path.join(output, "package-squirrel.json"), JSON.stringify({ passed: true,
        recordedAt: new Date().toISOString(), source, operations, locations: ["Desktop", "StartMenu"],
        isolatedTitle: title, method: "Real copied packaged EXE and updater; only fixture identity and guarded entry wrapper changed; KnownFolder enumeration and Electron native Unicode Shell reader" }, null, 2) + "\n");
} catch (error) {
    const diagnostic = { passed: false, error: String(error), fixture, checked, operations,
        fixtureFiles: fs.existsSync(fixture) ? fs.readdirSync(fixture) : [],
        links: [...(checked?.desktop || []), ...(checked?.startMenu || [])].map(link => ({ path: link.path, base64: fs.readFileSync(link.path).toString("base64") })),
        updaterLog: fs.existsSync(path.join(fixture, "SquirrelSetup.log")) ? fs.readFileSync(path.join(fixture, "SquirrelSetup.log"), "utf8").slice(-16000) : undefined };
    fs.writeFileSync(path.join(output, "package-squirrel-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
    console.error(JSON.stringify(diagnostic));
    throw error;
} finally {
    // Remove only this run's uniquely named links, even if an assertion failed.
    if (fs.existsSync(updater) && fs.existsSync(path.join(packages, "RELEASES"))) {
        spawnSync(updater, ["--removeShortcut", "MusicFree.exe", "--shortcut-locations=Desktop,StartMenu"], { timeout: 20000, windowsHide: true });
    }
    const remaining = probe();
    for (const link of [...remaining.desktop, ...remaining.startMenu]) {
        if (remaining.startMenu.includes(link)) menuGroups.add(path.dirname(link.path));
        assert.equal(path.basename(link.path), title + ".lnk"); fs.rmSync(link.path, { force: true });
    }
    for (const group of menuGroups) {
        if (path.basename(group) === id && fs.existsSync(group) && fs.readdirSync(group).length === 0) fs.rmdirSync(group);
    }
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
}

// Diagnostic reproduction for R3; no network access, real temporary file operations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const {load} = require(path.join(root, 'scripts/tests/source-loader.cjs'));
const constants = load('src/common/constant.ts');
let worker;
load('src/webworkers/downloader.ts', {
    comlink: {expose: api => worker = api},
    '@/common/constant': constants,
    '@/common/normalize-util': {encodeUrlHeaders: url => url},
});
fs.mkdirSync(path.join(root, 'out'), {recursive:true});
const directory = fs.mkdtempSync(path.join(root, 'out/.review-collision-'));
fs.writeFileSync(path.join(directory, 'CaseProbe'), 'probe');
const caseInsensitive = fs.existsSync(path.join(directory, 'caseprobe'));
fs.unlinkSync(path.join(directory, 'CaseProbe'));
if (!caseInsensitive) {
    fs.rmSync(directory, {recursive:true,force:true});
    console.log('SKIP: this filesystem is case-sensitive; use a case-insensitive volume');
    process.exit(0);
}
const originalFetch = global.fetch;
let calls = 0, release;
const gate = new Promise(resolve => release = resolve);
global.fetch = async url => {
    if (++calls === 2) release();
    await gate;
    return new Response(url.endsWith('/a') ? 'AAAA' : 'BBBB');
};
(async () => {
    const results = await Promise.all([
        worker.downloadFile({url:'https://test.invalid/a'},path.join(directory,'Song.mp3'),()=>{}),
        worker.downloadFile({url:'https://test.invalid/b'},path.join(directory,'song.mp3'),()=>{}),
    ]);
    const files = fs.readdirSync(directory);
    console.log(JSON.stringify({results,files,contents:files.map(file=>fs.readFileSync(path.join(directory,file),'utf8'))},null,2));
    assert.equal(results.filter(result=>result.state===constants.DownloadState.DONE).length,2);
    assert.equal(files.length,1,'reproduced: both tasks report DONE but only one file survives');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
    global.fetch=originalFetch;
    fs.rmSync(directory,{recursive:true,force:true});
});

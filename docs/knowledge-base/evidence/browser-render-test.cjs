/* Browser regression for the offline knowledge base. No player modules are loaded. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const docs = path.resolve(__dirname, '..');
const root = path.resolve(docs, '../..');
const testRoot = path.join(root, 'out', '.knowledge-base-render-' + Date.now());
fs.mkdirSync(testRoot, { recursive: true });
app.setPath('userData', path.join(testRoot, 'profile'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
let window;
const remoteRequests = [];
const consoleErrors = [];
const deadline = setTimeout(() => {
    console.error('Knowledge-base browser test timed out');
    window?.destroy(); app.exit(1);
}, 60000);
async function evaluate(code) { return window.webContents.executeJavaScript(code); }
async function frame() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function capture(file) {
    // A hidden Chromium window can finish DOM layout before its compositor repaints.
    await evaluate('new Promise(resolve => setTimeout(resolve, 150))');
    fs.writeFileSync(path.join(testRoot, file), (await window.webContents.capturePage()).toPNG());
}
async function inspectPreviewImage() {
    const view = await evaluate(`(async () => {
        const image=document.querySelector('#vinyl-player-preview img');
        image.scrollIntoView({block:'center'});
        await image.decode();
        const rect=image.getBoundingClientRect();
        return {src:image.currentSrc,complete:image.complete,naturalWidth:image.naturalWidth,
            naturalHeight:image.naturalHeight,width:rect.width,height:rect.height,
            containerWidth:image.closest('.chapter').clientWidth};
    })()`);
    assert.equal(new URL(view.src).protocol, 'file:');
    assert(view.src.endsWith('/assets/previews/vinyl-real-detail-playing.png'));
    assert(view.complete && view.naturalWidth > 0 && view.naturalHeight > 0);
    assert(view.width > 0 && view.height > 0 && view.width <= view.containerWidth);
    return view;
}
async function inspectThemePreview() {
    const views = await evaluate(`(async () => {
        const chapter=document.querySelector('#jiangnan-porcelain-theme');
        const images=[...chapter.querySelectorAll('img')];
        await Promise.all(images.map(image=>image.decode()));
        return images.map(image=>{
            const rect=image.getBoundingClientRect();
            return {src:image.currentSrc,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,
                width:rect.width,height:rect.height,containerWidth:chapter.clientWidth,
                originalLink:[...chapter.querySelectorAll('a')].find(link=>link.href===image.currentSrc)?.href};
        });
    })()`);
    assert.equal(views.length, 2, 'Both theme concept images must be embedded');
    for (const [index, view] of views.entries()) {
        assert.equal(new URL(view.src).protocol, 'file:');
        assert(view.src.endsWith('/assets/previews/' + (index === 0
            ? 'jiangnan-porcelain-main-v1.png' : 'jiangnan-porcelain-detail-mini-v1.png')));
        assert(view.naturalWidth > 0 && view.naturalHeight > 0);
        assert(view.width > 0 && view.height > 0 && view.width <= view.containerWidth);
        assert.equal(view.originalLink, view.src, 'Original-size theme image link missing');
    }
    return views;
}
async function inspectDiagrams() {
    return evaluate(`([...document.querySelectorAll('.diagram')].filter(x => x.closest('.chapter').getBoundingClientRect().height > 0)).map(figure => {
        const svg = figure.querySelector('.diagram-output svg');
        const rect = svg?.getBoundingClientRect();
        const viewBox = svg?.viewBox.baseVal;
        return { id: figure.id, state: figure.dataset.diagramState, width: rect?.width, height: rect?.height,
            viewWidth: viewBox?.width, viewHeight: viewBox?.height, labels: svg?.querySelectorAll('text, .nodeLabel').length,
            containerWidth: figure.querySelector('.diagram-output').clientWidth,
            sourceOpen: figure.querySelector('details').open };
    })`);
}
function assertVisible(diagram) {
    assert.equal(diagram.state, 'rendered', diagram.id);
    for (const value of [diagram.width, diagram.height, diagram.viewWidth, diagram.viewHeight]) {
        assert(Number.isFinite(value) && value > 0, JSON.stringify(diagram));
    }
    assert(diagram.labels > 0, 'SVG labels missing: ' + diagram.id);
    assert(diagram.width <= diagram.containerWidth, 'Diagram wider than container: ' + diagram.id);
    assert(diagram.width <= diagram.viewWidth + 1, 'Diagram unnecessarily enlarged: ' + diagram.id);
    assert.equal(diagram.sourceOpen, false);
}
(async () => {
    await app.whenReady();
    window = new BrowserWindow({ width: 1600, height: 1180, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    // Prove that file:// diagrams work with all HTTP(S) requests blocked.
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^https?:/.test(details.url);
        if (remote) remoteRequests.push(details.url);
        callback({ cancel: remote });
    });
    window.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3) consoleErrors.push(message);
    });
    await window.loadFile(path.join(docs, 'index.html'));
    const initial = await evaluate('window.knowledgeBaseReady');
    assert.deepEqual(initial, { total: 13, rendered: 13, failed: 0 });
    assert.equal(await evaluate('document.querySelector("#print").disabled'), false);
    const chapters = await evaluate('[...document.querySelectorAll(".chapter")].map(x => x.id)');
    assert(chapters.includes('commit-convention') && chapters.includes('commit-review')
        && chapters.includes('review-evidence') && chapters.includes('download-file-state')
        && chapters.includes('vinyl-player-preview') && chapters.includes('jiangnan-porcelain-theme'), 'New chapters missing');
    assert.equal(await evaluate(`(() => {
        const links = [...document.querySelectorAll('#guide a')];
        return links.some(x => x.getAttribute('href') === '#commit-convention')
            && links.some(x => x.getAttribute('href') === '#commit-review')
            && links.some(x => x.getAttribute('href') === '#review-evidence')
            && links.some(x => x.getAttribute('href') === '#download-file-state')
            && links.some(x => x.getAttribute('href') === '#vinyl-player-preview')
            && links.some(x => x.getAttribute('href') === '#jiangnan-porcelain-theme');
    })()`), true, 'Guide links to new chapters missing');
    const desktop = [];
    const previewImages = {};
    const themePreview = {};
    let previewLargeLink;
    for (const chapter of chapters) {
        await evaluate('location.hash = ' + JSON.stringify(chapter));
        await frame();
        const diagrams = await inspectDiagrams();
        diagrams.forEach(assertVisible); desktop.push(...diagrams);
        if (chapter === 'codebase' || chapter === 'flows') {
            await evaluate('document.querySelector(".chapter:not([hidden]) .diagram").scrollIntoView({block:"center"})');
            await frame();
            await capture(chapter + '.png');
        }
        if (chapter === 'download-file-state') {
            assert.equal(diagrams.length, 4);
            for (const [number, name] of [[2, 'implemented'], [4, 'before']]) {
                const figure = '#download-file-state-diagram-' + number;
                const source = fs.readFileSync(path.join(root, 'docs/design/download-file-state', name + '.puml'), 'utf8').replace(/\r\n/g, '\n');
                assert.equal(await evaluate('document.querySelector(' + JSON.stringify(figure + ' code.language-plantuml') + ').textContent'), source);
                assert.equal(await evaluate(`(() => {
                    const figure = document.querySelector(${JSON.stringify(figure)});
                    const svg = figure.querySelector('svg');
                    figure.querySelector('summary').click();
                    const opened = figure.querySelector('details').open;
                    figure.querySelector('summary').click();
                    return opened && figure.querySelector('svg') === svg;
                })()`), true, 'PlantUML source toggle failed');
                await evaluate('document.querySelector(' + JSON.stringify(figure) + ').scrollIntoView({block:"center"})');
                await frame();
                await capture('download-' + name + '.png');
            }
            const text = await evaluate(`document.querySelector('#download-file-state').textContent`);
            for (const label of ['当前资源状态机', '历史状态机', '已解决问题', '本轮已实现并验证']) assert(text.includes(label));
        }
        if (chapter === 'vinyl-player-preview') {
            previewImages.desktop = await inspectPreviewImage();
            previewLargeLink = await evaluate(`document.querySelector('#vinyl-player-preview a[href="assets/previews/vinyl-real-detail-playing.png"]').href`);
            assert.equal(await evaluate(`document.querySelector('#vinyl-player-preview').textContent.includes('已改用写实唱臂与黑胶素材')`), true);
            assert.equal(await evaluate(`document.querySelector('#vinyl-player-preview').textContent.includes('已接入播放器')`), true);
            const previewAssets = await evaluate(`(async () => { const images=[...document.querySelectorAll('#vinyl-player-preview img')]; await Promise.all(images.map(x=>x.decode())); return images.map(x=>({url:x.currentSrc,width:x.naturalWidth,height:x.naturalHeight})) })()`);
            assert.equal(previewAssets.length, 6);
            assert(previewAssets.every(x => new URL(x.url).protocol === 'file:' && x.width > 0 && x.height > 0));
            await frame(); await capture('vinyl-player-preview.png');
        }
        if (chapter === 'jiangnan-porcelain-theme') {
            themePreview.desktop = await inspectThemePreview();
            const text=await evaluate(`document.querySelector('#jiangnan-porcelain-theme').textContent`);
            assert(text.includes('效果图提案，待你确认后再开发') && text.includes('没有修改播放器主题代码'));
            for (const [index, name] of [[0, 'jiangnan-main'], [1, 'jiangnan-detail-mini']]) {
                await evaluate(`document.querySelectorAll('#jiangnan-porcelain-theme img')[${index}].scrollIntoView({block:'center'})`);
                await frame(); await capture(name + '.png');
            }
        }
    }
    assert.equal(desktop.length, 13);
    await evaluate(`(() => { const search=document.querySelector('#search'); search.value='UNAVAILABLE'; search.dispatchEvent(new Event('input')); })()`);
    assert.equal(await evaluate(`document.querySelector('.chapter-link[data-target="download-file-state"]').hidden`), false);
    await evaluate(`(() => { const search=document.querySelector('#search'); search.value='青花'; search.dispatchEvent(new Event('input')); })()`);
    assert.equal(await evaluate(`document.querySelector('.chapter-link[data-target="jiangnan-porcelain-theme"]').hidden`), false);
    await evaluate(`(() => { const search=document.querySelector('#search'); search.value=''; search.dispatchEvent(new Event('input')); })()`);
    await evaluate('location.hash = "commit-review"'); await frame();
    assert.equal(await evaluate(`document.querySelector('#commit-review:not([hidden])')?.textContent.includes('R1：本地文件与下载器拥有的文件混用了同一字段')`), true);
    assert.equal(await evaluate(`document.querySelector('#audit a[href="#commit-review"]') !== null`), true, 'Audit chapter backlink missing');
    // The source remains available without replacing or re-rendering the SVG.
    await evaluate('location.hash = "guide"'); await frame();
    assert.equal(await evaluate(`(() => { const figure=document.querySelector('#guide .diagram');
        const svg=figure.querySelector('svg'); figure.querySelector('summary').click();
        const opened=figure.querySelector('details').open && figure.querySelector('code').textContent.includes('flowchart');
        figure.querySelector('summary').click(); return opened && figure.querySelector('svg') === svg; })()`), true);
    window.setSize(600, 1000); await frame();
    const narrow = [];
    for (const chapter of chapters) {
        await evaluate('location.hash = ' + JSON.stringify(chapter)); await frame();
        const diagrams = await inspectDiagrams(); diagrams.forEach(assertVisible); narrow.push(...diagrams);
        if (chapter === 'vinyl-player-preview') previewImages.narrow = await inspectPreviewImage();
        if (chapter === 'jiangnan-porcelain-theme') {
            themePreview.narrow = await inspectThemePreview();
            await evaluate(`document.querySelector('#jiangnan-porcelain-theme img').scrollIntoView({block:'center'})`);
            await frame(); await capture('jiangnan-narrow.png');
        }
    }
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
    const printed = await inspectDiagrams(); printed.forEach(assertVisible); assert.equal(printed.length, 13);
    previewImages.print = await inspectPreviewImage();
    themePreview.print = await inspectThemePreview();
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '' });
    window.webContents.debugger.detach();
    assert.deepEqual(consoleErrors, [], 'Normal page console errors');
    const normalPageConsoleErrors = consoleErrors.length;
    // Follow the real large-view links and verify that both local SVG files display.
    const largeViews = [];
    const largeLinks = await evaluate(`[...document.querySelectorAll('#download-file-state figcaption a')].map(x => x.href)`);
    assert.equal(largeLinks.length, 2);
    for (const [index, url] of largeLinks.entries()) {
        assert.equal(new URL(url).protocol, 'file:');
        await window.loadURL(url);
        const view = await evaluate(`(() => { const svg=document.querySelector('svg'); const rect=svg?.getBoundingClientRect();
            return {width:rect?.width,height:rect?.height,labels:svg?.textContent}; })()`);
        assert(view.width > 0 && view.height > 0);
        for (const label of index === 0 ? ['AVAILABLE', 'MISSING', 'UNAVAILABLE'] : ['NONE', 'SAVING', 'DONE']) assert(view.labels.includes(label));
        largeViews.push({ url, width: view.width, height: view.height });
    }
    assert.equal(new URL(previewLargeLink).protocol, 'file:');
    await window.loadURL(previewLargeLink);
    const originalImage = await evaluate(`(async () => {
        const image=document.querySelector('img'); await image.decode();
        return {width:image.naturalWidth,height:image.naturalHeight};
    })()`);
    assert.equal(originalImage.width, previewImages.desktop.naturalWidth);
    assert.equal(originalImage.height, previewImages.desktop.naturalHeight);
    themePreview.originalImages = [];
    for (const view of themePreview.desktop) {
        await window.loadURL(view.originalLink);
        const original = await evaluate(`(async () => { const image=document.querySelector('img'); await image.decode();
            return {width:image.naturalWidth,height:image.naturalHeight}; })()`);
        assert.equal(original.width, view.naturalWidth);
        assert.equal(original.height, view.naturalHeight);
        themePreview.originalImages.push(original);
    }
    // A malformed Mermaid graph must not prevent the other twelve from displaying.
    let malformed = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
    malformed = malformed.replace('src="vendor/mermaid/mermaid.min.js"', 'src="' + pathToFileURL(path.join(docs, 'vendor/mermaid/mermaid.min.js')).href + '"');
    malformed = malformed.replace(/<code class="language-mermaid">[\s\S]*?<\/code>/,
        '<code class="language-mermaid">not-a-valid-diagram</code>');
    const malformedFile = path.join(testRoot, 'malformed.html'); fs.writeFileSync(malformedFile, malformed);
    await window.loadFile(malformedFile);
    const fallback = await evaluate('window.knowledgeBaseReady');
    assert.deepEqual(fallback, { total: 13, rendered: 12, failed: 1 });
    assert.equal(await evaluate(`(() => { const figure=document.querySelector('.diagram[data-diagram-state="failed"]');
        return figure.querySelector('details').open && !figure.querySelector('.diagram-error').hidden
            && figure.querySelector('.diagram-error').textContent.length > 0; })()`), true);
    assert.deepEqual(remoteRequests, [], 'Unexpected network request');
    const report = { platform: process.platform, architecture: process.arch, electron: process.versions.electron,
        chromium: process.versions.chrome, protocol: 'file:', network: 'HTTP(S) blocked; no requests attempted',
        initial, desktop, narrowDiagrams: narrow.length, printDiagrams: printed.length,
        sourceToggle: 'Mermaid and both PlantUML sources passed', largeViews,
        previewImages, originalPreviewImage: originalImage, themePreview,
        invalidDiagramFallback: fallback, normalPageConsoleErrors,
        screenshots: ['codebase', 'flows', 'download-implemented', 'download-before', 'vinyl-player-preview',
            'jiangnan-main', 'jiangnan-detail-mini', 'jiangnan-narrow'].map(name => path.join(testRoot, name + '.png')) };
    fs.writeFileSync(path.join(__dirname, 'browser-render-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('PASS', JSON.stringify({ initial, narrow: narrow.length, print: printed.length, fallback, remoteRequests: remoteRequests.length,
        preview: 'local image decoded at desktop/narrow/print sizes; original-size link passed',
        themePreview: 'two local images decoded at desktop/narrow/print sizes; navigation, search and both original-size links passed' }));
    console.log('SCREENSHOTS', JSON.stringify(report.screenshots));
    clearTimeout(deadline); window.destroy(); app.exit(0);
})().catch(error => { console.error(error.stack || String(error)); clearTimeout(deadline); window?.destroy(); app.exit(1); });

module.exports = async () => {
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const req = require('node:module').createRequire(path.resolve('package.json'));
    const { load, deferred } = req('./scripts/tests/source-loader.cjs');
    const React = req('react'), ReactDOM = req('react-dom/client');
    const { act } = req('react-dom/test-utils');
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.getElementById('test-root');
    let mounted = 0;
    function Child() { React.useEffect(() => { mounted++; }, []); return React.createElement('span', null, 'Player ready'); }
    for (const fail of [true, false]) {
        const held = deferred();
        const Initialize = load('src/renderer/document/initialize.tsx', {
            './bootstrap': () => held.promise,
            '@shared/logger/renderer': { logPerf() {}, logError() { throw new Error('logger also failed'); } },
        }).default;
        const view = ReactDOM.createRoot(container);
        await act(async () => view.render(React.createElement(Initialize, null, React.createElement(Child))));
        assert.ok(container.querySelector('[role=status]')); assert.equal(mounted, 0);
        await act(async () => {
            fail ? held.reject(new Error('下载记录初始化失败：Injected IndexedDB failure')) : held.resolve();
            await Promise.resolve();
        });
        if (fail) {
            assert.ok(container.querySelector('[role=alert]'));
            assert.ok(container.textContent.includes('Injected IndexedDB failure'));
            assert.equal(container.querySelector('button').textContent, '重新启动');
            assert.equal(mounted, 0);
        } else {
            assert.ok(container.textContent.includes('Player ready')); assert.equal(mounted, 1);
        }
        await act(async () => view.unmount());
    }
    return 'PASS: real React startup loading/error/restart UI, logger failure isolation and no player mount before successful initialization';
};

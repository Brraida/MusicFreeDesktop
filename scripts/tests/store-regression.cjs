const assert = require("node:assert/strict");
const { load } = require("./source-loader.cjs");
const { default: Store } = load("src/common/store.ts", { react: {} });
const store = new Store(0), calls = [], renders = [];
const unsubscribe = store.onValueChange(() => {
    throw new Error("expected subscriber failure");
});
store.onValueChange((next, prev) => calls.push([next, prev, store.getValue()]));
store.stateMapper.cbs.add(() => {
    throw new Error("expected render subscriber failure");
});
store.stateMapper.cbs.add(() => renders.push(store.getValue()));
const errors = [], original = console.error;
console.error = (...args) => errors.push(args);
try {
    assert.doesNotThrow(() => store.setValue(1));
    assert.equal(store.getValue(), 1);
    assert.deepEqual(calls, [[1, 0, 1]]); assert.deepEqual(renders, [1]);
    unsubscribe(); store.setValue(prev => prev + 1);
    assert.equal(store.getValue(), 2);
    assert.deepEqual(calls.at(-1), [2, 1, 2]); assert.deepEqual(renders, [1, 2]);
    assert.equal(errors.length, 3);
    assert.throws(() => store.setValue(() => {
        throw new Error("update failed");
    }));
    assert.equal(store.getValue(), 2); assert.equal(calls.length, 2);
} finally {
    console.error = original;
}
console.log("PASS: Store commits before notification, isolates subscribers and retains state on update failure");

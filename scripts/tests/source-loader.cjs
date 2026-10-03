const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");

function load(relative, mocks = {}, suffix = "") {
    const source = fs.readFileSync(path.join(root, relative), "utf8") + suffix;
    const code = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS,
        esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", code)(name => {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        if (!name.startsWith("@") && !name.startsWith(".")) return require(name);
        throw new Error("Unmocked import: " + name);
    }, module, module.exports);
    return module.exports;
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a; reject = b;
    });
    return { promise, resolve, reject };
}

module.exports = { load, deferred, root };

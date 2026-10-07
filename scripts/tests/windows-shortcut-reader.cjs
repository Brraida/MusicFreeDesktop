// Read links through Electron's native Unicode Shell API and exchange UTF-8 files.
const { app, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[2];
app.setPath("userData", path.join(path.dirname(file), "link-reader-profile"));
try {
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const location of ["desktop", "startMenu"]) {
        result[location] = result[location].map(link => {
            const native = shell.readShortcutLink(link.path);
            return { ...link, wscriptTarget: link.target, target: native.target, arguments: native.args };
        });
    }
    fs.writeFileSync(file, JSON.stringify(result));
    app.exit(0);
} catch (error) {
    console.error(error);
    app.exit(1);
}

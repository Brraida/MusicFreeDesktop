import { app } from "electron";
import { handleSquirrelEvent } from "./squirrel-events";

if (!handleSquirrelEvent(app)) {
    // Keep all player, protocol, native module and configuration initialization
    // out of install/update/uninstall processes, including their static imports.
    require("./index");
}

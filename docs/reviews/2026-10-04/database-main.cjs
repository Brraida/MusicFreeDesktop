// Diagnostic reproduction for R1/R2 at 4e7b711; uses isolated test data only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');process.chdir(root);
const testRoot=path.join(root,'out/.review-evidence-'+Date.now());fs.mkdirSync(testRoot,{recursive:true});
app.setPath('userData',path.join(testRoot,'data'));
let window;const timer=setTimeout(()=>{console.error('probe timed out');app.exit(1);},30000);
(async()=>{
 await app.whenReady();
 window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
 const html=path.join(testRoot,'index.html');fs.writeFileSync(html,'<!doctype html><div id="test-root"></div>');await window.loadFile(html);
 const source=fs.readFileSync(path.join(__dirname,'renderer.cjs'),'utf8');
 const result=await window.webContents.executeJavaScript(`(async()=>{const module={exports:{}};${source}\nreturn await module.exports(${JSON.stringify(testRoot)});})()`);
 fs.writeFileSync(path.join(testRoot,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 clearTimeout(timer);window.destroy();app.exit(0);
})().catch(error=>{console.error(error);app.exit(1)});

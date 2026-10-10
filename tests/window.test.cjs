const {app,BrowserWindow,ipcMain}=require('electron');
const sizeReports=[];
ipcMain.on('app:contentSize',(_event,size)=>{sizeReports.push({size,bounds:BrowserWindow.getAllWindows()[0]?.getBounds()});if(sizeReports.length>6)sizeReports.shift();});
const fs=require('fs');const path=require('path');const os=require('os');const assert=require('assert/strict');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'speed-pet-window-test-'));
process.env.CODEX_HOME=path.join(data,'codex');
fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({size:'small',autoHideChrome:true,reducedMotion:true}));
app.setPath('userData',data);app.disableHardwareAcceleration();
BrowserWindow.prototype.show=function(){};
let usage={day:null,input:100000,output:5000,total:34260000,historyTotal:2480000000,rateLimits:{updatedAt:Date.now(),fiveHour:{remainingPercent:19,resetsAt:Date.now()+7500000},weekly:{remainingPercent:77,resetsAt:Date.now()+450000000}},speed:132,turnSpeed:null,turnTokens:null,turnSeconds:null,active:false,running:false,lastEvent:null,eventCount:0,source:'ready',error:null};
const {UsageCollector}=require('../electron/usage.cjs');
UsageCollector.prototype.snapshot=function(){return usage;};
// Use the real main process and IPC, with an offscreen window so hidden test
// frames still run ResizeObserver just as the visible application does.
const Module=require('node:module');
const nativeElectron=require('electron');
const mainPath=path.resolve(__dirname,'../electron/main.cjs');
const loadModule=Module._load;
Module._load=function(request,parent,isMain){
 if(request==='electron' && parent?.filename===mainPath){
  return {...nativeElectron,BrowserWindow:function(options){return new BrowserWindow({...options,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});}};
 }
 return loadModule.call(this,request,parent,isMain);
};
try{require(mainPath);}finally{Module._load=loadModule;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function enter(win){await win.webContents.executeJavaScript(`document.querySelector('.gauge-wrap').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:null}))`);await sleep(150);}
async function leave(win){await win.webContents.executeJavaScript(`document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))`);await sleep(1900);}
async function state(win){
 const ui=await win.webContents.executeJavaScript(`(()=>{
  const shell=document.querySelector('.shell'),viewport=document.querySelector('.viewport'),reset=document.querySelector('.quota-reset');
  const scale=Number(viewport.style.zoom);
  const expected=Math.ceil(viewport.offsetHeight*scale);
  const horizontal=[...document.querySelectorAll('.statistics div,.statistics span,.statistics strong')].filter(el=>{if(!el.getClientRects().length)return false;const r=el.getBoundingClientRect(),p=document.querySelector('.statistics').getBoundingClientRect();return r.right>p.right+1 || r.left<p.left-1}).map(el=>el.className||el.tagName);
  return {collapsed:shell.classList.contains('is-collapsed'),scale,expected,resetFont:parseFloat(getComputedStyle(reset).fontSize)*scale,headerVisible:getComputedStyle(document.querySelector('.window-header')).display!=='none',statsVisible:getComputedStyle(document.querySelector('.statistics')).display!=='none',quotaVisible:getComputedStyle(document.querySelector('.quota-card')).display!=='none',speedVisible:document.querySelector('.speed-card').getClientRects().length>0,speedText:document.querySelector('.speed-card').innerText,panel:!!document.querySelector('.overlay'),horizontal};
 })()`);
 const bounds=win.getBounds();if(Math.abs(bounds.height-ui.expected)>1)console.log(JSON.stringify({ui,bounds,sizeReports}));assert.ok(Math.abs(bounds.height-ui.expected)<=1,'native height must follow content within Windows DPI / Chromium zoom rounding');assert.ok(Math.abs(bounds.width-Math.round(272*ui.scale))<=1,'native width must follow selected scale within Windows DPI rounding');return {...ui,bounds};
}
app.whenReady().then(async()=>{
 const win=BrowserWindow.getAllWindows()[0];
 // Hidden smoke windows should render at the same cadence as a visible app.
 win.webContents.setBackgroundThrottling(false);
 if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r));
 await sleep(500);await enter(win);await sleep(4300);
 assert.equal((await state(win)).collapsed,false,'hover must cancel the initial collapse timer');
 for(const size of ['small','medium','large']){
  await win.webContents.executeJavaScript(`window.speedPet.updateSettings({size:'${size}',autoHideChrome:true})`);await sleep(250);await enter(win);
  const expanded=await state(win);assert.equal(expanded.collapsed,false);assert.ok(expanded.resetFont>=11.9);assert.deepEqual(expanded.horizontal,[]);
  if(process.env.SPEED_PET_TEST_SCREENSHOTS)fs.writeFileSync('preview-layout-expanded-'+size+'.png',(await win.webContents.capturePage()).toPNG());
  await leave(win);const collapsed=await state(win);assert.equal(collapsed.collapsed,true);assert.equal(collapsed.headerVisible,false);assert.equal(collapsed.statsVisible,true);assert.equal(collapsed.speedVisible,true);assert.equal(collapsed.quotaVisible,false);assert.match(collapsed.speedText,/输出速度/);assert.match(collapsed.speedText,/今日累计/);assert.match(collapsed.speedText,/历史累计/);assert.ok(collapsed.bounds.height<expanded.bounds.height-50);
  if(process.env.SPEED_PET_TEST_SCREENSHOTS)fs.writeFileSync('preview-layout-folded-'+size+'.png',(await win.webContents.capturePage()).toPNG());
  await enter(win);assert.equal((await state(win)).collapsed,false);
  console.log(JSON.stringify({size,expanded:expanded.bounds,folded:collapsed.bounds,resetFont:expanded.resetFont}));
 }
 await win.webContents.executeJavaScript(`window.speedPet.updateSettings({size:'small'})`);await sleep(250);await enter(win);
 await win.webContents.executeJavaScript(`document.querySelector('.speed-card').click()`);await leave(win);
 const panel=await state(win);assert.equal(panel.panel,true);assert.equal(panel.collapsed,false);assert.equal(panel.scale,.82);
 await win.webContents.executeJavaScript(`document.querySelector('.panel-close').click()`);await leave(win);
 const closed=await state(win);assert.equal(closed.panel,false);assert.equal(closed.collapsed,true);assert.equal(closed.scale,.55);
 await win.webContents.executeJavaScript(`window.speedPet.updateSettings({autoHideChrome:false})`);await sleep(2000);assert.equal((await state(win)).collapsed,false);
 for(const kind of ['missing','expired','partial']){
  usage={...usage,rateLimits:kind==='missing'?null:{updatedAt:Date.now(),fiveHour:{remainingPercent:0,resetsAt:kind==='expired'?Date.now()-1000:null},weekly:null}};
  win.webContents.send('usage:update',usage);await sleep(200);
  const current=await state(win);assert.ok(current.resetFont>=11.9);assert.deepEqual(current.horizontal,[]);
}
console.log('Hover, native bounds, minimum fonts, panel expansion/restore, disabling collapse and unknown/expired quotas: passed');
console.log('Temporary test data: '+data);
 app.quit();
}).catch(error=>{console.error(error);app.exit(1)});

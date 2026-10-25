/* 同一份演示数据核对两分支的布局、文字一致；浏览器不读取个人配置。 */
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..'),runtime=path.join(root,'runtime');
process.env.TEMP=process.env.TMP=path.join(runtime,'temp');
const {chromium}=require('playwright-core');
(async()=>{
 const glass=process.argv.includes('--glass'),name=glass?'液态玻璃':'原风格';
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disk-cache-dir='+path.join(runtime,'temp','visual-branch-cache')]});
 const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const config={writingConfigured:false,writingBase:'https://api.deepseek.com/v1',writingModel:'deepseek-chat',asrConfigured:false,parserConfigured:false,asrInterval:6,parserInterval:1,workspaceDirectory:''};
 await context.route('**/api/config',r=>r.fulfill({json:config}));
 await context.route('**/api/library',r=>r.fulfill({json:{configured:false,entries:[],locations:{},warnings:[],workspaceDirectory:''}}));
 await context.route('**/api/jobs',r=>r.fulfill({json:{jobs:[]}}));
 await context.route('**/api/workbench',r=>r.fulfill({json:{configured:false,exists:false,revision:0,state:null}}));
 try{
  await page.goto(process.env.SPOKEN_DNA_TEST_URL||'http://127.0.0.1:8766');await page.waitForFunction(()=>window.dnaFlow?.ready&&window.appSettings?.loaded);
  await page.locator('#tryExample').click();await page.locator('#toastContainer').evaluate(n=>n.replaceChildren());
  const snapshot=()=>page.evaluate(()=>({text:[...document.querySelectorAll('h1,h2,h3,button,label,summary,.workspace-process,.version-heading')].map(n=>n.textContent.trim()),boxes:Object.fromEntries(['.topbar','.dna-sidebar','main.main','#spokenInput','.workspace-process','#cleanupWorkspace','.version-grid','#spokenResult'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [selector,[r.x,r.y,r.width,r.height]];})),primary:getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()}));
  const desktop=await snapshot();await page.screenshot({path:path.join(root,'docs','工作台-'+name+'.png'),fullPage:true});
  await page.locator('#sidebarBuild').click();const dialog=await page.locator('#dnaBuilderDialog').boundingBox();assert(dialog.x>=0&&dialog.x+dialog.width<=1441);await page.screenshot({path:path.join(root,'docs','建立DNA-'+name+'.png')});
  await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  await page.locator('#sidebarBuild').click();const mobile=await page.locator('#dnaBuilderDialog').boundingBox();assert(mobile.x>=0&&mobile.x+mobile.width<=391&&mobile.height<=844);await page.screenshot({path:path.join(runtime,'工作台-'+name+'-窄屏.png')});assert.deepEqual(errors,[]);
  if(!glass)fs.writeFileSync(path.join(runtime,'style-baseline.json'),JSON.stringify(desktop),'utf8');
  else {const baseline=JSON.parse(fs.readFileSync(path.join(runtime,'style-baseline.json'),'utf8'));assert.deepEqual(desktop.text,baseline.text,'样式分支不能改变页面文字和控件');for(const [k,box]of Object.entries(desktop.boxes))for(let i=0;i<4;i++)assert(Math.abs(box[i]-baseline.boxes[k][i])<=1,k+' 的布局发生变化');assert.notEqual(desktop.primary,baseline.primary);}
  console.log(JSON.stringify({theme:name,desktopAndMobile:true,sameLayoutAndText:glass?true:'已保存对照基准',scriptErrors:errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

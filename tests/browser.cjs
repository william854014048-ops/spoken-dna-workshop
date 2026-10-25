/* Headless Edge，模拟上游返回；真实运行原网页的分析、保存、成稿和备份代码。 */
const path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.resolve(__dirname,'..');
process.env.TEMP=process.env.TMP=process.env.TMPDIR=path.join(root,'runtime','temp');
const {chromium}=require('playwright-core');
const baseURL=process.env.SPOKEN_DNA_TEST_URL||'http://127.0.0.1:8765';
const output=path.join(root,'runtime','browser-check');fs.mkdirSync(output,{recursive:true});
const report=[];
async function check(name,fn){await fn();report.push(name);console.log('PASS '+name);}
(async()=>{
 const browserOptions=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'};
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{headless:true,...browserOptions,viewport:{width:1440,height:1100},downloadsPath:output,args:['--disk-cache-dir='+path.join(output,'cache'),'--disable-application-cache']});
 const page=context.pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let jobs=[],configPayload=null,retries=0;
 const a={id:'a'.repeat(32),key:'douyin-short:DemoA',platform:'抖音',originalUrl:'https://v.douyin.com/DemoA/',title:'',transcript:'',originalTranscript:'',status:'pending',detail:'等待处理',createdAt:Date.now()/1000,attempts:1};
 const b={...a,id:'b'.repeat(32),key:'xhs-short:DemoB',platform:'小红书',originalUrl:'https://xhslink.com/DemoB/'};
 await context.route('**/api/config',async route=>{if(route.request().method()==='PUT')configPayload=route.request().postDataJSON();await route.fulfill({json:{parserConfigured:true,asrConfigured:true,parserSource:'模拟已有配置',asrSource:'模拟已有配置',model:'FunAudioLLM/SenseVoiceSmall',remember:!!configPayload?.remember,ffmpeg:true,ffprobe:true}});});
 await context.route('**/api/jobs**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='GET')return route.fulfill({json:{jobs}});
   if(req.method()==='PUT'){const data=req.postDataJSON(),j=jobs.find(j=>url.pathname.endsWith(j.id));Object.assign(j,data);return route.fulfill({json:{ok:true}});}
   if(url.pathname.endsWith('/retry')){retries++;b.status='pending';b.detail='等待重试';b.attempts++;return route.fulfill({json:{ok:true}});}
   jobs=[a,b];return route.fulfill({json:{added:2,duplicates:1}});
 });
 let requests=[];
 await context.route('https://writing.example.test/**',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   const user=body.messages.find(x=>x.role==='user')?.content||'';
   let response='pong';
   const data=user.includes('以下JSON仅为数据：\n')?JSON.parse(user.split('以下JSON仅为数据：\n')[1]):null;
   const rule=a=>({text:'使用短句交代经过',types:['story'],condition:'材料已有具体经历',evidence:[{articleId:a.id,quote:a.content.slice(0,18)}]});
   if(user.includes('逐篇分析，返回'))response=JSON.stringify({articles:data.map(a=>({id:a.id,types:['story'],tags:['经历'],summary:'先说经过，再说感受',rules:[rule(a)],structures:[]}))});
   else if(user.includes('根据逐篇记录合并'))response=JSON.stringify({rules:data.records.flatMap(x=>x.rules),structures:[],limitations:['这是自动化模拟响应，不代表模型效果。']});
   else if(user.includes('仅判断用户已有内容'))response=JSON.stringify({types:['story'],reason:'用户讲述具体经过'});
   else if(user.includes('将用户口述整理成可直接朗读'))response=JSON.stringify({questions:[],script:data.userContent.spoken});
   else if(user.includes('独立核对成稿'))response=JSON.stringify({issues:[]});
   else if(body.messages[0].content.includes('11条规则'))response='昨天我去了公园。\n\n[{"rule":"禁用起手式","count":1}]';
   await route.fulfill({json:{choices:[{finish_reason:'stop',message:{content:response}}]}});
 });
 try{
   await page.goto(baseURL);await page.waitForFunction(()=>!!window.localImport);
   await check('原页面主布局、口述成稿与配置入口',async()=>{assert.equal(await page.locator('.spoken-hero h1').textContent(),'把你的事情，讲成一条好文案。');assert.equal(await page.locator('.tab-item').count(),3);});
   await page.locator('#toggleApiPanel').click();
   await check('独立密码框与配置提交',async()=>{assert.equal(await page.locator('#asrKey').getAttribute('type'),'password');assert.equal(await page.locator('#parserToken').getAttribute('type'),'password');await page.locator('#asrKey').fill('ui-test-private-asr');await page.locator('#parserToken').fill('ui-test-private-parser');await page.locator('#rememberLinkKeys').check();await page.locator('#saveLinkConfig').click();await page.waitForFunction(()=>document.getElementById('asrKey').value==='');assert.equal(configPayload.asrKey,'ui-test-private-asr');assert.equal(configPayload.parserToken,'ui-test-private-parser');});
   await page.locator('#apiKey').fill('ui-test-writing-key');await page.locator('#apiBase').fill('https://writing.example.test/v1');await page.locator('#saveApiBtn').click();
   await page.locator('#toggleApiPanel').click();await page.locator('[data-tab="distill"]').click();await page.locator('#modeLinks').click();
   await check('混合分享文案、多链接与重复跳过反馈',async()=>{await page.locator('#shareLinksInput').fill('视频一 https://v.douyin.com/DemoA/ 第二条 https://xhslink.com/DemoB/ 重复 https://v.douyin.com/DemoA/');await page.locator('#startLinkImport').click();await page.waitForFunction(()=>document.querySelectorAll('.link-job').length===2);assert((await page.locator('#toastContainer').textContent()).includes('重复跳过 1'));assert.equal(await page.locator('.link-status').first().textContent(),'待处理');});
   for(const [status,label] of [['parsing','解析中'],['transcribing','转文字中']]){a.status=status;a.detail=label;await page.evaluate(()=>window.localImport.refreshJobs());await page.waitForFunction(label=>document.querySelector('.link-status').textContent===label,label);}
   a.status='success';a.title='模拟口播标题';a.transcript=a.originalTranscript='昨天我到公园。看到一棵树。今天我想记录这件事。';a.detail='模拟转写成功';b.status='failed';b.detail='模拟平台解析失败';
   await page.evaluate(()=>window.localImport.refreshJobs());
   await check('逐条成功失败并存，失败可单独重试',async()=>{await page.waitForFunction(()=>document.querySelector('[data-job-id="'+ 'b'.repeat(32)+'"] [class="link-status"]').textContent==='失败');await page.locator('.link-job').nth(1).getByRole('button',{name:'重试此项'}).click();await page.waitForFunction(()=>document.querySelectorAll('.link-status')[1].textContent==='待处理');assert.equal(retries,1);assert.equal(await page.locator('.link-status').first().textContent(),'成功');});
   await check('查看修改原文，加入原稿且不直接生成DNA',async()=>{await page.locator('.link-editor').first().locator('summary').first().click();await page.locator('.link-editor').first().getByRole('textbox',{name:'转写原文',exact:true}).fill('昨天我到公园。看到一棵大树。今天我想记录这件事。');await page.getByRole('button',{name:'加入原稿列表',exact:true}).first().click();await page.waitForFunction(()=>document.querySelectorAll('#articleList .article-item').length===1);const stateData=await page.evaluate(()=>({article:state.articles[0],dna:state.distillResults.dna,lib:app.library.length}));assert(stateData.article.content.includes('一棵大树'));assert(stateData.article.originalTranscript.includes('一棵树'));assert.equal(stateData.article.platform,'抖音');assert.equal(stateData.dna,'');assert.equal(stateData.lib,0);});
   await page.evaluate(()=>{document.getElementById('toastContainer').replaceChildren();scrollTo(0,0);});
   await page.screenshot({path:path.join(root,'docs','分享链接导入.png'),fullPage:true});
   await check('原稿列表查看与编辑保存',async()=>{await page.locator('#articleList').getByRole('button',{name:'查看／编辑'}).first().click();await page.locator('#singleTitle').fill('已编辑标题');await page.locator('#confirmAddBtn').click();assert((await page.locator('#articleList').textContent()).includes('已编辑标题'));assert.equal(await page.locator('#articleList .article-item').count(),1);});
   await page.locator('#modeText').click();
   await check('原有批量文本导入和逐篇添加',async()=>{await page.locator('#batchInput').fill(['第二篇\n今天我去河边散步。水很清。','第三篇\n今天我去山上散步。风很大。','第四篇\n今天我去了图书馆。读完一本书。'].join('\n---\n'));await page.locator('#importBatchBtn').click();await page.locator('#addSingleBtn').click();await page.locator('#singleTitle').fill('第五篇');await page.locator('#singleContent').fill('昨天我坐公交上班。路上遇到老朋友。');await page.locator('#confirmAddBtn').click();assert.equal(await page.locator('#articleList .article-item').count(),5);assert.equal(await page.locator('#startDistillBtn').isEnabled(),true);});
   await check('转写原稿接续原DNA分析与DNA库保存（模型响应模拟）',async()=>{await page.locator('#startDistillBtn').click();await page.waitForFunction(()=>document.getElementById('distillStepText').textContent.includes('分析完成'),{timeout:20000});assert(requests.some(r=>r.messages.some(m=>m.content.includes('一棵大树'))));await page.locator('#dnaLibraryName').fill('回归验证 DNA');await page.locator('#saveLibraryDna').click();await page.waitForFunction(()=>document.querySelectorAll('.dna-choice').length===1);assert((await page.locator('.dna-choice').textContent()).includes('5 篇'));});
   await check('口述成稿与独立核对保留（模型响应模拟）',async()=>{await page.locator('#spokenInput').fill('昨天我去公园散步，看到一棵大树，我很开心。');await page.locator('#spokenGenerate').click();await page.waitForFunction(()=>document.getElementById('spokenStatus').textContent.includes('生成完成'),{timeout:20000});assert((await page.locator('#spokenResult').textContent()).includes('昨天我去公园'));assert((await page.locator('#reviewStatus').textContent()).includes('已完成'));});
   await check('原有去AI味调用与结果保留（模型响应模拟）',async()=>{await page.locator('#sendCleanup').click();await page.locator('#deaiInput').fill('说白了，昨天我去了公园。');await page.locator('#startDeaiBtn').click();await page.waitForFunction(()=>document.getElementById('deaiOutput').textContent==='昨天我去了公园。');});
   await page.locator('[data-tab="write"]').click();
   await check('实际导出项目备份不含三类密钥',async()=>{const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#backupProject').click()]);const destination=path.join(output,'项目备份.json');await download.saveAs(destination);const raw=fs.readFileSync(destination,'utf8');for(const key of ['ui-test-private-asr','ui-test-private-parser','ui-test-writing-key'])assert(!raw.includes(key));const parsed=JSON.parse(raw);assert.equal(parsed.app.library.length,1);assert.equal(parsed.articles.length,5);assert.equal(parsed.articles[0].platform,'抖音');});
   await check('项目备份恢复与刷新持久化',async()=>{page.once('dialog',d=>d.accept());await page.locator('#projectFile').setInputFiles(path.join(output,'项目备份.json'));await page.waitForTimeout(700);await page.waitForFunction(()=>!!window.localImport);assert.equal(await page.locator('.dna-choice').count(),1);assert.equal(await page.locator('#articleList .article-item').count(),5);assert.equal(await page.locator('#apiKey').inputValue(),'');assert((await page.locator('#spokenResult').textContent()).includes('昨天我去公园'));});
   await page.evaluate(()=>{document.getElementById('toastContainer').replaceChildren();scrollTo(0,0);});
   await page.screenshot({path:path.join(root,'docs','本地主页面.png'),fullPage:true});
   await check('窄屏布局与脚本无异常',async()=>{await page.setViewportSize({width:390,height:844});await page.locator('[data-tab="distill"]').click();await page.locator('#modeLinks').click();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);assert.equal(overflow,false);assert.deepEqual(errors,[]);});
   fs.writeFileSync(path.join(root,'docs','浏览器验证.json'),JSON.stringify({mode:'外部解析、转写与写作接口均为模拟响应；真实执行本地页面',checks:report,scriptErrors:errors},null,2),'utf8');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

/* Headless Edge，模拟上游返回；真实运行原网页的分析、保存、成稿和备份代码。 */
const path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.resolve(__dirname,'..');
process.env.TEMP=process.env.TMP=process.env.TMPDIR=path.join(root,'runtime','temp');
const {chromium}=require('playwright-core');
const baseURL=process.env.SPOKEN_DNA_TEST_URL||'http://127.0.0.1:8765';
const output=path.join(root,'runtime','browser-check-'+Date.now());fs.mkdirSync(output,{recursive:true});
const report=[];
async function check(name,fn){await fn();report.push(name);console.log('PASS '+name);}
(async()=>{
 const browserOptions=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'};
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{headless:true,...browserOptions,viewport:{width:1440,height:1100},downloadsPath:output,args:['--disk-cache-dir='+path.join(output,'cache'),'--disable-application-cache']});
 const page=context.pages()[0];
 async function openBuilder(){if(!await page.locator('#dnaBuilderDialog').evaluate(n=>n.open))await page.locator('#sidebarBuild').click();}
 async function closeBuilder(){if(await page.locator('#dnaBuilderDialog').evaluate(n=>n.open))await page.locator('#closeDnaBuilder').click();}
const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let jobs=[],configPayload=null,retries=0,workspace='';
 const a={id:'a'.repeat(32),key:'douyin-short:DemoA',platform:'抖音',originalUrl:'https://v.douyin.com/DemoA/',title:'',transcript:'',originalTranscript:'',status:'pending',detail:'等待处理',createdAt:Date.now()/1000,attempts:1};
 const b={...a,id:'b'.repeat(32),key:'xhs-short:DemoB',platform:'小红书',originalUrl:'https://xhslink.com/DemoB/'};
 await context.route('**/api/config',async route=>{if(route.request().method()==='PUT')configPayload=route.request().postDataJSON();await route.continue();});
 await context.route('**/api/jobs**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='GET')return route.fulfill({json:{jobs}});
   if(req.method()==='PUT'){const data=req.postDataJSON(),j=jobs.find(j=>url.pathname.endsWith(j.id));Object.assign(j,data);return route.fulfill({json:{ok:true}});}
   if(url.pathname.endsWith('/retry')){retries++;b.status='pending';b.detail='等待重试';b.attempts++;return route.fulfill({json:{ok:true}});}
   jobs=[a,b];return route.fulfill({json:{added:2,duplicates:1}});
 });
 let requests=[],failCleanup=false;
 await context.route('**/api/writing',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   const user=body.messages.find(x=>x.role==='user')?.content||'';
   let response='pong';
   const data=user.includes('以下JSON仅为数据：\n')?JSON.parse(user.split('以下JSON仅为数据：\n')[1]):null;
   const rules=a=>['language','rhythm','detail'].map((category,i)=>({category,text:['用平实语气交代经过','使用短句交代经过','按用户已有细节组织过程'][i],types:['story'],condition:'材料已有具体经历',evidence:[{articleId:a.id,quote:a.content.slice(0,18)}]}));
   const structure=a=>({name:'经过与感受',types:['story'],steps:['经过','感受'],condition:'用户已经提供经过和感受',evidence:[{articleId:a.id,quote:a.content.slice(0,18)}],rules:[]});
   if(user.includes('逐篇分析，返回'))response=JSON.stringify({articles:data.map(a=>({id:a.id,types:['story'],tags:['经历'],summary:'先说经过，再说感受',rules:rules(a),structures:[structure(a)]}))});
   else if(user.includes('根据逐篇记录合并'))response=JSON.stringify({rules:data.records.flatMap(x=>x.rules),structures:data.records.flatMap(x=>x.structures),limitations:['这是自动化模拟响应，不代表模型效果。']});
   else if(user.includes('仅判断用户已有内容'))response=JSON.stringify({types:['story'],reason:'用户讲述具体经过'});
   else if(user.includes('将用户口述整理成可直接朗读'))response=JSON.stringify({questions:[],script:data.userContent.spoken});
   else if(user.includes('独立核对成稿'))response=JSON.stringify({issues:[]});
   else if(body.messages[0].content.includes('11条规则')){if(failCleanup)return route.fulfill({status:500,json:{error:'模拟服务失败'}});response=user.replace(/^说白了，/,'')+'\n\n[{"rule":"禁用起手式","count":1}]';}
   await route.fulfill({json:{choices:[{finish_reason:'stop',message:{content:response}}]}});
 });
 try{
   await page.goto(baseURL);await page.waitForFunction(()=>!!window.dnaFlow&&window.dnaFlow.ready);
   await check('DNA 未配置提醒及中文本地目录连接',async()=>{
     await page.waitForFunction(()=>window.dnaDisk);
     await page.waitForFunction(()=>!document.getElementById('dnaDiskNotice').hidden);
     assert((await page.locator('#dnaDiskNotice').textContent()).includes('尚未选择'));
     await page.locator('#toggleApiPanel').click();
     assert(await page.locator('#settingsDialog').isVisible());assert(await page.locator('#dnaDirectory').getAttribute('readonly')!==null);
     await page.locator('#apiKey').fill('ui-test-writing-key');
     await page.locator('#chooseWorkspace').click();
     await page.waitForFunction(()=>window.dnaDisk.configured);
     assert.equal(await page.locator('#apiKey').inputValue(),'ui-test-writing-key');
     workspace=await page.locator('#dnaDirectory').inputValue();
     await page.locator('#closeSettings').click();
     assert(fs.existsSync(workspace));
   });
   await check('左侧建立DNA弹窗，主工作台仅成稿与清理两步',async()=>{assert.equal(await page.locator('.spoken-hero h1').textContent(),'把你的原话，写成你喜欢的表达。');assert.equal(await page.locator('.tab-nav').isVisible(),false);assert.equal(await page.locator('.workspace-process span').count(),2);assert.equal(await page.locator('#dnaBuilderDialog').isVisible(),false);assert(await page.locator('.dna-sidebar').isVisible());assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()),'#2a6b6b');});
   await page.locator('#toggleApiPanel').click();
   await check('弹框统一保存三项密钥且语音模型固定',async()=>{assert.equal(await page.locator('#asrKey').getAttribute('type'),'password');assert.equal(await page.locator('#parserToken').getAttribute('type'),'password');assert.equal(await page.locator('#asrModel').count(),0);await page.locator('#asrKey').fill('ui-test-private-asr');await page.locator('#parserToken').fill('ui-test-private-parser');await page.locator('#apiKey').fill('ui-test-writing-key');await page.locator('#apiBase').fill('https://writing.example.test/v1');await page.locator('#saveApiBtn').click();await page.waitForFunction(()=>!document.getElementById('settingsDialog').open);assert.equal(configPayload.asrKey,'ui-test-private-asr');assert.equal(configPayload.parserToken,'ui-test-private-parser');assert.equal(configPayload.writingKey,'ui-test-writing-key');assert(fs.existsSync(path.join(workspace,'config.json')));assert(fs.existsSync(path.join(workspace,'credentials.dpapi')));});
   await openBuilder();await page.locator('#modeLinks').click();
   await check('混合分享文案、多链接与重复跳过反馈',async()=>{await page.locator('#shareLinksInput').fill('视频一 https://v.douyin.com/DemoA/ 第二条 https://xhslink.com/DemoB/ 重复 https://v.douyin.com/DemoA/');await page.locator('#startLinkImport').click();await page.waitForFunction(()=>document.querySelectorAll('.link-job').length===2);assert((await page.locator('#toastContainer').textContent()).includes('重复跳过 1'));assert.equal(await page.locator('.link-status').first().textContent(),'待处理');});
   for(const [status,label] of [['parsing','解析中'],['transcribing','转文字中'],['rate_limited','限流等待']]){a.status=status;a.detail=label;await page.evaluate(()=>window.localImport.refreshJobs());await page.waitForFunction(label=>document.querySelector('.link-status').textContent===label,label);}
   a.status='success';a.title='模拟口播标题';a.transcript=a.originalTranscript='昨天我到公园。看到一棵树。今天我想记录这件事。';a.detail='模拟转写成功';b.status='failed';b.detail='模拟平台解析失败';
   await page.evaluate(()=>window.localImport.refreshJobs());
   await check('逐条成功失败并存，失败可单独重试',async()=>{await page.waitForFunction(()=>document.querySelector('[data-job-id="'+ 'b'.repeat(32)+'"] [class="link-status"]').textContent==='失败');await page.locator('.link-job').nth(1).getByRole('button',{name:'重试此项'}).click();await page.waitForFunction(()=>document.querySelectorAll('.link-status')[1].textContent==='待处理');assert.equal(retries,1);assert.equal(await page.locator('.link-status').first().textContent(),'成功');});
   await check('查看修改原文，加入原稿且不直接生成DNA',async()=>{await page.locator('.link-editor').first().locator('summary').first().click();await page.locator('.link-editor').first().getByRole('textbox',{name:'转写原文',exact:true}).fill('昨天我到公园。看到一棵大树。今天我想记录这件事。');await page.getByRole('button',{name:'加入原稿列表',exact:true}).first().click();await page.waitForFunction(()=>document.querySelectorAll('#articleList .article-item').length===1);const stateData=await page.evaluate(()=>({article:state.articles[0],dna:state.distillResults.dna,lib:app.library.length}));assert(stateData.article.content.includes('一棵大树'));assert(stateData.article.originalTranscript.includes('一棵树'));assert.equal(stateData.article.platform,'抖音');assert.equal(stateData.dna,'');assert.equal(stateData.lib,0);});
   await check('刷新转写状态不打断编辑，关闭建立弹窗保留输入',async()=>{const area=page.locator('.link-editor').first().getByRole('textbox',{name:'转写原文',exact:true});await area.focus();await page.evaluate(()=>window.localImport.refreshJobs());assert(await area.evaluate(n=>document.activeElement===n));await page.locator('#shareLinksInput').fill('未提交的下一条链接');await page.keyboard.press('Escape');assert.equal(await page.locator('#dnaBuilderDialog').isVisible(),false);await openBuilder();assert.equal(await page.locator('#shareLinksInput').inputValue(),'未提交的下一条链接');});
   await page.evaluate(()=>{document.getElementById('toastContainer').replaceChildren();scrollTo(0,0);});
   await page.screenshot({path:path.join(root,'docs','分享链接导入.png'),fullPage:true});
   await check('原稿列表查看与编辑保存',async()=>{await page.locator('#articleList').getByRole('button',{name:'查看／编辑'}).first().click();await page.locator('#singleTitle').fill('已编辑标题');await page.locator('#confirmAddBtn').click();assert((await page.locator('#articleList').textContent()).includes('已编辑标题'));assert.equal(await page.locator('#articleList .article-item').count(),1);});
   await page.locator('#modeText').click();
   await check('原有批量文本导入和逐篇添加',async()=>{await page.locator('#batchInput').fill(['第二篇\n今天我去河边散步。水很清。','第三篇\n今天我去山上散步。风很大。','第四篇\n今天我去了图书馆。读完一本书。'].join('\n---\n'));await page.locator('#importBatchBtn').click();await page.locator('#addSingleBtn').click();await page.locator('#singleTitle').fill('第五篇');await page.locator('#singleContent').fill('昨天我坐公交上班。路上遇到老朋友。');await page.locator('#confirmAddBtn').click();assert.equal(await page.locator('#articleList .article-item').count(),5);assert.equal(await page.locator('#startDistillBtn').isEnabled(),true);});
   await check('转写原稿接续原DNA分析与磁盘DNA保存（模型响应模拟）',async()=>{await page.locator('#startDistillBtn').click();await page.waitForFunction(()=>document.getElementById('distillStepText').textContent.includes('分析完成'),{timeout:20000});assert(requests.some(r=>r.messages.some(m=>m.content.includes('一棵大树'))));await page.locator('#dnaLibraryName').fill('回归验证 DNA');await page.locator('#saveLibraryDna').click();await page.waitForFunction(()=>document.querySelectorAll('.dna-choice').length===1);assert((await page.locator('.dna-choice').textContent()).includes('5 篇'));const folders=fs.readdirSync(path.join(workspace,'DNA'));assert.equal(folders.length,1);assert(fs.existsSync(path.join(workspace,'DNA',folders[0],'dna.json')));});
   await check('已用转写自动归档，建立下一份DNA有明确入口',async()=>{await openBuilder();await page.locator('#modeLinks').click();await page.waitForFunction(()=>document.querySelector('#linkHistoryQueue .link-job'));assert.equal(await page.locator('#linkHistory').isVisible(),true);assert.equal(await page.locator('#articleList .article-item').count(),0);assert(await page.locator('#builderNextAuthor').isVisible());await closeBuilder();});
   await check('口述成稿与独立核对保留（模型响应模拟）',async()=>{await page.locator('#spokenInput').fill('昨天我去公园散步，看到一棵大树，我很开心。');await page.locator('#spokenGenerate').click();await page.waitForFunction(()=>document.getElementById('spokenStatus').textContent.includes('生成完成'),{timeout:20000});assert((await page.locator('#spokenResult').textContent()).includes('昨天我去公园'));assert((await page.locator('#reviewStatus').textContent()).includes('已完成'));});
   await check('一键去AI味与独立清理均保留（模型响应模拟）',async()=>{await page.locator('#sendCleanup').click();await page.waitForFunction(()=>app.cleanup?.fromDraft);assert.equal(await page.evaluate(()=>app.cleanup.source),await page.evaluate(()=>app.result));await page.locator('#standaloneCleanup>summary').click();await page.locator('#deaiInput').fill('说白了，昨天我去了公园。');await page.locator('#startDeaiBtn').click();await page.waitForFunction(()=>document.getElementById('deaiOutput').textContent==='昨天我去了公园。');});
   await closeBuilder();
   await check('实际导出项目备份不含三类密钥',async()=>{const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#backupProject').click()]);const destination=path.join(output,'项目备份.json');await download.saveAs(destination);const raw=fs.readFileSync(destination,'utf8');for(const key of ['ui-test-private-asr','ui-test-private-parser','ui-test-writing-key'])assert(!raw.includes(key));const parsed=JSON.parse(raw);assert.equal(parsed.app.library.length,1);const all=Object.values(parsed.app.authorSpaces).flatMap(x=>x.articles);assert.equal(all.length,5);assert.equal(all[0].platform,'抖音');});
   await check('项目备份恢复与刷新持久化',async()=>{page.once('dialog',d=>d.accept());await page.locator('#projectFile').setInputFiles(path.join(output,'项目备份.json'));await page.waitForTimeout(700);await page.waitForFunction(()=>!!window.localImport);assert.equal(await page.locator('.dna-choice').count(),1);assert.equal(await page.evaluate(()=>Object.values(app.authorSpaces).flatMap(x=>x.articles).length),5);assert.equal(await page.locator('#apiKey').inputValue(),'');assert((await page.locator('#spokenResult').textContent()).includes('昨天我去公园'));});
   await check('清除浏览器缓存后仍从本地目录恢复DNA',async()=>{
     await page.evaluate(async()=>{await window.dnaDisk.flush();await window.dnaFlow.flush();localStorage.clear();});await page.reload();
     await page.waitForFunction(()=>window.dnaFlow?.diskReady&&document.querySelectorAll('.dna-choice').length===1);
     assert((await page.locator('.dna-choice').textContent()).includes('回归验证 DNA'));
   });
   await check('刷新和清缓存后配置与密钥无需重新输入',async()=>{
     await page.waitForFunction(()=>window.appSettings?.loaded);await page.locator('#toggleApiPanel').click();
     assert((await page.locator('#apiKey').getAttribute('placeholder')).includes('已保存'));
     assert.equal(await page.locator('#apiBase').inputValue(),'https://writing.example.test/v1');
     assert.equal(await page.locator('#asrKey').inputValue(),'');assert((await page.locator('#asrKey').getAttribute('placeholder')).includes('已保存'));
     await page.keyboard.press('Escape');assert.equal(await page.locator('#settingsDialog').isVisible(),false);
   });
   await check('下一位作者新建素材分组，保留原作者和历史记录',async()=>{
     await openBuilder();await page.locator('#modeLinks').click();
     assert(await page.locator('#nextDnaAuthor').isVisible());await page.locator('#nextDnaAuthor').click();
     assert.equal(await page.locator('#articleList .article-item').count(),0);assert.equal(await page.locator('.dna-choice').count(),1);
   });
   await page.evaluate(()=>{document.getElementById('toastContainer').replaceChildren();scrollTo(0,0);});
   await page.screenshot({path:path.join(root,'docs','本地主页面.png'),fullPage:true});
   await check('窄屏布局与脚本无异常',async()=>{await page.setViewportSize({width:390,height:844});await openBuilder();await page.locator('#modeLinks').click();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);assert.equal(overflow,false);assert.deepEqual(errors,[]);});
   await check('设置以弹框显示且桌面和窄屏均不撑开页面',async()=>{
     await closeBuilder();await page.setViewportSize({width:1440,height:1000});await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.target?.closest?.('.tab-nav')).map(a=>a.finished.catch(()=>{})));});const before=await page.evaluate(()=>document.body.scrollHeight);
     await page.locator('#toggleApiPanel').click();assert(Math.abs((await page.evaluate(()=>document.body.scrollHeight))-before)<=2);
     assert(await page.locator('#settingsDialog').isVisible());const desktop=await page.locator('#settingsDialog').boundingBox();assert(Math.abs(desktop.x-(1440-desktop.width)/2)<=2);await page.screenshot({path:path.join(root,'docs','设置弹框.png')});
     await page.setViewportSize({width:390,height:844});const box=await page.locator('#settingsDialog').boundingBox();
     assert(box.x>=0&&box.x+box.width<=391);assert(box.y>=0&&box.height<=844);
     await page.screenshot({path:path.join(output,'设置弹框-窄屏.png')});await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
   });
   await page.setViewportSize({width:1440,height:1100});
   await check('成功链接批量入文章库，作者自动分类且未知作者不猜测',async()=>{
     await openBuilder();await page.locator('#modeLinks').click();
     jobs.push({...a,id:'c'.repeat(32),key:'douyin-short:C',originalUrl:'https://v.douyin.com/C',title:'作者甲的视频',authorName:'作者甲',authorId:'uid-A',transcript:'甲的原稿。真实测试分组。',originalTranscript:'甲的原稿。真实测试分组。'},
       {...a,id:'d'.repeat(32),key:'douyin-short:D',originalUrl:'https://v.douyin.com/D',title:'作者乙的视频',authorName:'作者乙',authorId:'uid-B',transcript:'乙的原稿。真实测试分组。',originalTranscript:'乙的原稿。真实测试分组。'});
     await page.evaluate(()=>window.localImport.refreshJobs());await page.locator('#addSuccessfulLinks').click();
     await page.waitForFunction(()=>Object.values(app.authorSpaces).some(s=>s.name==='作者乙'&&s.articles.length===1)&&app.authorSpaces[app.activeAuthor]?.name==='作者乙');
     const spaces=await page.evaluate(()=>Object.values(app.authorSpaces).map(s=>({name:s.name,count:s.articles.length})));
     assert(spaces.some(s=>s.name==='作者甲'&&s.count===1));assert(spaces.some(s=>s.name==='作者乙'&&s.count===1));assert(spaces.some(s=>s.count===5));
     assert.equal(await page.evaluate(()=>app.library.length),1);assert(await page.locator('#goAnalyzeArticles').isVisible());
   });
   await check('作者素材与分析分别保留，可按风格保存第二份DNA',async()=>{
     await page.locator('#nextDnaAuthor').click();await page.locator('#authorName').fill('参考作者 B');await page.locator('#dnaStyleName').fill('直接讲解');
     await page.locator('#modeText').click();await page.locator('#batchInput').fill(Array.from({length:5},(_,i)=>'B的第'+i+'篇\n今天我尝试第'+i+'种方法。过程很清楚。我愿意再试一次。').join('\n---\n'));await page.locator('#importBatchBtn').click();
     await page.locator('#startDistillBtn').click();await page.waitForFunction(()=>document.getElementById('distillStepText').textContent.includes('分析完成'));
     await page.locator('#dnaLibraryName').fill('B 的直接讲解');await page.locator('#saveLibraryDna').click();await page.waitForFunction(()=>app.library.length===2);
     assert.equal(await page.evaluate(()=>app.library[1].style),'直接讲解');await page.locator('#dnaStyleFilter').selectOption('直接讲解');assert.equal(await page.locator('.dna-choice').count(),1);await page.locator('#dnaStyleFilter').selectOption('');
   });
   await check('三类项目Skill从独立文件读取且实际进入写作请求',async()=>{const bundle=await page.request.get(baseURL+'/api/skills');const data=await bundle.json();assert.deepEqual(Object.keys(data.skills).sort(),['deai-edit','dna-compose','dna-extract']);for(const name of Object.keys(data.skills)){assert(fs.existsSync(path.join(root,'skills',name,'SKILL.md')));}assert(requests.some(r=>r.messages.some(m=>m.content.includes(data.skills['dna-extract'].batch))));assert(requests.some(r=>r.messages.some(m=>m.content.includes(data.skills['dna-compose'].review))));assert(requests.some(r=>r.messages.some(m=>m.content.includes('11条规则'))));});
   let expectedSelection;
   await check('整份DNA与跨作者模块组合，同类型替换并保存预设',async()=>{
     const ids=await page.evaluate(()=>app.library.map(d=>d.id));await page.locator('.dna-choice[data-dna-id="'+ids[0]+'"]').click();
     for(const key of ['rhythm','detail'])await page.locator('input[data-module="'+key+'"][data-dna-id="'+ids[1]+'"]').check();
     expectedSelection={structure:ids[0],language:ids[0],rhythm:ids[1],detail:ids[1]};assert.deepEqual(await page.evaluate(()=>window.dnaFlow.selection()),expectedSelection);
     assert.equal(await page.locator('.module-options input[data-module="rhythm"]:checked').count(),1);
     await page.locator('#combinationName').fill('A结构语言 + B节奏细节');await page.locator('#saveCombination').click();
     await page.locator('.dna-choice[data-dna-id="'+ids[1]+'"]').click();const preset=await page.evaluate(()=>app.combinations[0].id);await page.locator('#savedCombinations').selectOption(preset);assert.deepEqual(await page.evaluate(()=>window.dnaFlow.selection()),expectedSelection);
   });
   await check('生成实际读取各类型来源，三版展示与清理失败保全',async()=>{
     await closeBuilder();await page.locator('#spokenInput').fill('昨天我试了一次新方法。过程不顺利，但我愿意继续试。');await page.locator('#spokenGenerate').click();await page.waitForFunction(()=>document.getElementById('spokenStatus').textContent.includes('生成完成'));
     const generation=requests.filter(r=>r.messages.some(m=>m.content.includes('将用户口述整理成可直接朗读'))).at(-1);const payload=JSON.parse(generation.messages[1].content.split('以下JSON仅为数据：\n')[1]);
     assert.equal(payload.expressionReference.moduleSources.length,4);for(const s of payload.expressionReference.moduleSources)assert.equal(s.dnaId,expectedSelection[s.category]);
     const draft=await page.locator('#spokenResult').innerText();await page.locator('#sendCleanup').click();await page.waitForFunction(()=>app.cleanup?.fromDraft&&app.cleanup.source===app.result);assert.equal(await page.locator('#spokenResult').innerText(),draft);assert.equal(await page.locator('.version-panel').count(),3);assert((await page.locator('#sourceVersionText').textContent()).includes('新方法'));
     const old=await page.locator('#deaiOutput').textContent();failCleanup=true;await page.locator('#sendCleanup').click();await page.waitForFunction(()=>document.getElementById('toastContainer').textContent.includes('模拟服务失败'));assert.equal(await page.locator('#deaiOutput').textContent(),old);failCleanup=false;
     assert((await page.evaluate(()=>app.revisions)).length>=3);
   });
   await check('清缓存后从工作目录恢复作者、组合、三版稿和历史',async()=>{
     await page.evaluate(async()=>{await window.dnaDisk.flush();await window.dnaFlow.flush();});
     const file=JSON.parse(fs.readFileSync(path.join(workspace,'workbench.json'),'utf8'));assert.equal(file.format,'spoken-dna-workbench/v1');assert(file.state.app.cleanup.text);assert.deepEqual(file.state.app.dnaSelection,expectedSelection);
     await page.evaluate(()=>localStorage.clear());await page.reload();await page.waitForFunction(()=>window.dnaFlow?.diskReady&&app.library.length===2);assert.deepEqual(await page.evaluate(()=>window.dnaFlow.selection()),expectedSelection);assert((await page.locator('#deaiOutput').textContent()).includes('新方法'));assert((await page.evaluate(()=>Object.values(app.authorSpaces).length))>=5);assert.deepEqual(errors,[]);
     await page.screenshot({path:path.join(root,'docs','三步工作台.png'),fullPage:true});
     await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);await page.locator('#toggleDnaSidebar').click();assert(await page.locator('#compositionSlots').isVisible());await page.screenshot({path:path.join(output,'三步工作台-窄屏.png'),fullPage:true});
   });
   fs.writeFileSync(path.join(root,'docs','浏览器验证.json'),JSON.stringify({mode:'外部解析、转写与写作接口均为模拟响应；本地文件、加密配置和工作区实际执行',checks:report,scriptErrors:errors},null,2),'utf8');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

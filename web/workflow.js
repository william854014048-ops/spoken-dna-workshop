/* 三步工作台：作者素材 → 可组合的表达 DNA → 口述、成稿与清理版本。 */
(() => {
  'use strict';
  const el=id=>document.getElementById(id), clone=x=>structuredClone(x);
  const MODULES={structure:'结构 DNA',language:'语言 DNA',rhythm:'节奏 DNA',detail:'细节 DNA'};
  const emptyResults=()=>({dna:'',l1:'',l2:'',l35:'',l6:''});
  const uid=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
  function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
  function button(text,action,cls='btn btn-outline btn-sm'){const b=node('button',cls,text);b.type='button';b.onclick=action;return b;}
  function option(select,value,text){const o=node('option','',text);o.value=value;select.append(o);}
  function dnaById(id){return app.library.find(d=>d.id===id)||(id===DEMO.id?DEMO:null);}
  function profile(dna){return window.dnaV2.getProfile(dna);}
  function available(dna){const p=profile(dna);if(!p)return Object.keys(MODULES);return [...(p.structures.length?['structure']:[]),...['language','rhythm','detail'].filter(k=>p.rules.some(r=>r.category===k))];}
  function selection(){return Object.fromEntries(Object.keys(MODULES).filter(k=>dnaById(app.dnaSelection?.[k])).map(k=>[k,app.dnaSelection[k]]));}
  function selectionLabel(){const items=Object.entries(selection());if(!items.length)return '尚未选择 DNA';const ids=[...new Set(items.map(([,id])=>id))];return ids.length===1?dnaById(ids[0]).name:items.map(([k,id])=>MODULES[k].replace(' DNA','')+'·'+dnaById(id).name).join(' / ');}
  function normalizeApp(){
    app.dnaSelection=app.dnaSelection&&typeof app.dnaSelection==='object'&&!Array.isArray(app.dnaSelection)?app.dnaSelection:{};
    app.combinations=Array.isArray(app.combinations)?app.combinations:[];
    app.authorSpaces=app.authorSpaces&&typeof app.authorSpaces==='object'&&!Array.isArray(app.authorSpaces)?app.authorSpaces:{};
    app.revisions=Array.isArray(app.revisions)?app.revisions:[];
    if(!Object.keys(app.authorSpaces).length){app.activeAuthor='initial';app.authorSpaces.initial={name:app.author||'',articles:clone(state.articles),results:clone(state.distillResults),pendingProfile:clone(app.pendingProfile||null),style:''};}
    if(!app.authorSpaces[app.activeAuthor])app.activeAuthor=Object.keys(app.authorSpaces)[0];
    if(!Object.keys(app.dnaSelection).length&&app.selected&&!app.selectionInitialized){const d=dnaById(app.selected);if(d)for(const k of available(d))app.dnaSelection[k]=d.id;}
    app.selectionInitialized=true;
  }
  normalizeApp();
  app.archivedJobs=Array.isArray(app.archivedJobs)?app.archivedJobs:[];
  let restoring=true,saveTimer=null,saveChain=Promise.resolve(),diskRevision=0,diskReady=false,diskFolder='',diskConflict=false;
  let cleanupBusy=false,loadingFolder=false,compareMode='dna';
  const shell=node('div','workbench-shell'),aside=node('aside','dna-sidebar'),center=node('div','workbench-main');
  aside.setAttribute('aria-label','DNA 库与组合');
  document.querySelector('.tab-nav').before(shell);shell.append(aside,center);
  center.append(document.querySelector('.tab-nav'),el('requestActivity'),document.querySelector('main.main'));
  aside.innerHTML=`<section class="sidebar-section"><div class="sidebar-heading"><h2>我的表达 DNA</h2><button id="toggleDnaSidebar" class="btn btn-outline btn-sm" aria-expanded="false">展开 / 收起</button></div><p class="muted-note" id="sidebarSelectionLabel">选择已保存的风格，反复使用。</p></section>
    <section class="sidebar-section"><h3>本次表达组合</h3><div id="compositionSlots" class="composition-slots"></div><p class="muted-note">每类只选一个来源。选同类新来源时，会替换原来源。</p><div class="sidebar-controls"><input id="combinationName" aria-label="组合名称" placeholder="如：克制叙事 · 清晰讲解"><button class="btn btn-outline btn-sm" id="saveCombination">保存这个组合</button><select id="savedCombinations" aria-label="已保存的DNA组合"><option value="">选择已保存的组合</option></select></div></section>
    <section class="sidebar-section"><div class="sidebar-heading"><h3>DNA 库</h3><button id="sidebarBuild" class="btn btn-outline btn-sm">＋ 建立</button></div><div class="sidebar-controls"><input id="dnaSearch" aria-label="搜索DNA" placeholder="搜索作者、DNA 或风格"><select id="dnaStyleFilter" aria-label="按风格筛选"><option value="">全部风格</option></select></div><div id="sidebarLibraryMount"></div><div id="sidebarImportMount" class="library-import-tools"></div></section>
    <section class="sidebar-section"><div id="sidebarDiskMount"></div><p id="workbenchSaveStatus" class="workbench-save-status" role="status">正在读取本地工作区…</p></section>`;
  el('toggleDnaSidebar').onclick=()=>{aside.classList.toggle('expanded');el('toggleDnaSidebar').setAttribute('aria-expanded',String(aside.classList.contains('expanded')));};
  el('sidebarBuild').textContent='＋ 建立 DNA';el('sidebarBuild').onclick=()=>{if(app.authorSpaces[app.activeAuthor]?.savedDnaId&&!busy()){archiveFinished();switchAuthor(createAuthor());}openBuilder();};
  const oldDnaCard=el('dnaChoices').closest('.card');
  el('sidebarLibraryMount').append(el('dnaChoices'),el('selectedDnaInfo'));
  el('dnaChoices').classList.add('dna-library-list');
  el('sidebarDiskMount').append(el('dnaDiskNotice'),el('dnaDiskSummary'));
  el('sidebarImportMount').append(el('importDnaText').closest('details'));
  const example=el('tryExample');el('sidebarImportMount').append(example);
  el('goBuildDna').remove();
  const structurePanel=el('structureChoice').closest('.v2-panel'),materialsPanel=el('materialsPanel');
  const spokenCard=el('spokenInput').closest('.card');spokenCard.append(structurePanel,materialsPanel);
  oldDnaCard.remove();
  const nav=document.querySelector('.tab-nav');nav.prepend(nav.querySelector('[data-tab="distill"]'));nav.append(nav.querySelector('[data-tab="deai"]'));
  for(const [i,key]of ['distill','write','deai'].entries()){
    const t=nav.querySelector('[data-tab="'+key+'"]');t.innerHTML='<span class="tab-num">0'+(i+1)+'</span>'+({distill:'建立 DNA',write:'口述 · DNA 成稿',deai:'去 AI 味'}[key]);t.setAttribute('role','tab');t.setAttribute('tabindex','0');
    t.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();t.click();}});
    t.addEventListener('click',()=>{app.activeStep=key;renderJourney();saveConfig();for(const n of nav.children)n.setAttribute('aria-selected',String(n===t));});
  }
  nav.hidden=true;nav.setAttribute('aria-hidden','true');
  const builder=node('dialog','dna-builder-dialog');builder.id='dnaBuilderDialog';builder.setAttribute('aria-labelledby','dnaBuilderTitle');
  builder.innerHTML='<header class="builder-heading"><div><h2 id="dnaBuilderTitle">建立表达 DNA</h2><p>导入当前作者的素材，分析后保存到左侧 DNA 库。</p></div><button class="btn-icon" id="closeDnaBuilder" aria-label="关闭DNA建立窗口">×</button></header><div class="builder-body" id="dnaBuilderBody"></div><footer class="builder-footer"><span id="builderFooterStatus">文章与分析会自动保存，关闭后可以继续。</span><button class="btn btn-outline btn-sm" id="builderNextAuthor">＋ 添加下一位作者</button><button class="btn btn-primary btn-sm" id="builderDone">回到工作台</button></footer>';
  document.body.append(builder);el('dnaBuilderBody').append(el('tab-distill'));el('tab-distill').classList.add('active');builder.append(el('addArticleModal'));
  const cleanControls=el('tab-deai');cleanControls.classList.add('workspace-cleanup');cleanControls.classList.remove('active');cleanControls.hidden=false;cleanControls.style.display='block';
  el('closeDnaBuilder').onclick=closeBuilder;el('builderDone').onclick=closeBuilder;
  builder.addEventListener('cancel',event=>{event.preventDefault();closeBuilder();});
  builder.addEventListener('click',event=>{if(event.target!==builder)return;const r=builder.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeBuilder();});
  function openBuilder(){if(!builder.open){el('dnaBuilderBody').prepend(el('requestActivity'));builder.showModal();}renderAuthors();}
  function closeBuilder(){if(builder.open)builder.close();center.prepend(el('requestActivity'));el('sidebarBuild').focus();}
  function navigate(tab){app.activeStep='write';el('tab-write').classList.add('active');if(tab==='distill')openBuilder();else{closeBuilder();if(tab==='deai')el('cleanupWorkspace').scrollIntoView({behavior:'smooth',block:'start'});}renderJourney();saveConfig();}
  document.querySelector('.app-subtitle').textContent='选择表达 DNA · 口述成稿 · 自然表达';
  document.querySelector('.spoken-hero').innerHTML='<h1>把你的原话，写成你喜欢的表达。</h1><p>在左侧选整份 DNA，或按类型自由组合。事实、经历和观点始终以你说的为准。</p>';
  const context=node('div','draft-context');context.innerHTML='<strong>本次使用的 DNA</strong><p id="writingComposition"></p><button id="editComposition" class="btn btn-outline btn-sm">调整左侧组合</button>';el('spokenInput').before(context);
  el('editComposition').onclick=()=>{aside.classList.add('expanded');el('compositionSlots').scrollIntoView({behavior:'smooth',block:'center'});};
  el('spokenGenerate').textContent='按所选 DNA 生成口播稿';
  const intro=el('tab-distill').querySelector('.intro-strip');intro.className='flow-stage-header';intro.innerHTML='<h1>先把喜欢的表达，存成 DNA。</h1><p>参考素材按作者整理，再提取语言、结构、节奏和细节组织方式。文字与分享链接都进入同一套文章库。</p>';
  const sourceCard=node('section','card');sourceCard.innerHTML=`<div class="source-toolbar"><div class="form-group"><label for="referenceAuthor">当前参考作者</label><select id="referenceAuthor"></select></div><div class="form-group"><label for="newAuthorName">新增作者（名称可稍后填写）</label><input id="newAuthorName" placeholder="参考博主的昵称"></div><button id="createAuthor" class="btn btn-outline btn-sm">＋ 新建作者分组</button></div><p id="authorSpaceNote" class="source-note"></p>`;intro.after(sourceCard);
  el('authorName').placeholder='可选，给当前作者分组命名';
  el('authorName').closest('.form-group').insertAdjacentHTML('afterend','<div class="form-group"><label for="dnaStyleName">风格标签（可选）</label><input id="dnaStyleName" placeholder="如：克制叙事、直接讲解"></div>');
  el('linkImportPanel').querySelector('.link-notice').textContent='视频转写 → 加入文章库 → 按作者建立 DNA。接口未返回作者时会标为待确认；不会根据标题猜作者。小红书图文暂不支持。';
  const bulk=node('div','link-bulk-toolbar');bulk.innerHTML='<button id="addSuccessfulLinks" class="btn btn-primary btn-sm" disabled>将成功项加入文章库</button><select id="linkAuthorTarget" aria-label="链接原稿归属作者"><option value="auto">按识别到的作者自动归类</option></select><button id="goAnalyzeArticles" class="btn btn-outline btn-sm">下一步：建立 DNA →</button><p id="linkBulkHint">成功结果可批量加入，无需逐条复制。作者待确认的素材会单独保留。</p>';
  el('linkSummary').before(bulk);
  el('textImportPanel').before(Object.assign(node('div','material-route'),{innerHTML:'<b>01 导入素材</b><span>→</span><b>02 按作者整理文章</b><span>→</span><b>03 提取并保存 DNA</b>'}));
  el('articleList').closest('.card').querySelector('.card-title').lastChild.textContent=' 当前作者的文章';
  const guide=node('div','build-guide');guide.innerHTML='<div><strong id="buildGuideTitle"></strong><span id="buildGuideText"></span></div><button id="continueToWriting" class="btn btn-outline btn-sm">已有 DNA，去口述成稿 →</button>';el('startDistillBtn').closest('.card').append(guide);
  el('continueToWriting').onclick=()=>activate('write');
  el('saveLibraryDna').textContent='保存 DNA，进入口述成稿 →';
  el('saveLibraryDna').before(Object.assign(node('span','muted-note'),{textContent:'可按风格命名，保存后可整份使用或按类型组合。'}));
  const step3=node('div','flow-stage-header');step3.innerHTML='<h2>02　去 AI 味</h2><p>直接接续 DNA 成稿，保留原意与前一版文字。</p>';el('tab-deai').prepend(step3);
  el('tab-deai').id='cleanupWorkspace';
  const deaiLayout=el('deaiInput').closest('.deai-layout'),outputPanel=el('deaiOutput').closest('.deai-panel');
  const standalone=node('details');standalone.id='standaloneCleanup';standalone.innerHTML='<summary>查看 / 修改待清理文字，也可独立清理其他文案</summary>';deaiLayout.before(standalone);standalone.append(deaiLayout);
  const resultCard=el('spokenResultCard');resultCard.classList.add('document-journey');document.querySelector('main.main').append(resultCard);
  const heading=resultCard.querySelector('.card-header');heading.querySelector('.card-title').textContent='这一篇，怎样一步步变化';heading.classList.add('journey-heading');
  const grid=node('div','version-grid');
  const sourcePanel=node('section','version-panel');sourcePanel.innerHTML='<div class="version-heading"><span class="tab-num">01</span>我的原始口述</div><p id="sourceVersionCaption" class="version-caption"></p><div id="sourceVersionText" class="version-body"></div>';
  const dnaPanel=node('section','version-panel');dnaPanel.innerHTML='<div class="version-heading"><span class="tab-num">02</span>DNA 成稿</div><p id="dnaVersionCaption" class="version-caption"></p>';
  const cleanPanel=node('section','version-panel');cleanPanel.innerHTML='<div class="version-heading"><span class="tab-num">03</span>去 AI 味稿</div><p id="cleanVersionCaption" class="version-caption"></p>';
  grid.append(sourcePanel,dnaPanel,cleanPanel);heading.after(grid);dnaPanel.append(el('spokenResult'));cleanPanel.append(el('deaiOutput'));
  cleanPanel.append(el('copyDeaiBtn'));el('deaiOutput').setAttribute('role','textbox');el('deaiOutput').setAttribute('aria-label','可编辑的去AI味稿');el('deaiOutput').setAttribute('aria-multiline','true');outputPanel.remove();
  el('resultNote').hidden=true;
  const actionBar=el('sendCleanup').parentElement;actionBar.className='journey-actions';el('sendCleanup').textContent='直接去 AI 味 →';actionBar.append(button('导出去 AI 味稿',()=>download('我的口播稿-去AI味.txt',app.cleanup?.text||'')));
  actionBar.querySelector('.muted-note').textContent='可直接修改；原始口述与两版成稿分别保留，并自动保存到工作目录。';
  actionBar.append(button('回到口述修改',()=>activate('write')));
  const comparisons=node('details','flow-comparison');comparisons.innerHTML='<summary>查看文字变化与历史版本</summary><div class="compare-controls"><button id="compareDna" class="btn btn-outline btn-sm">原始口述 → DNA 成稿</button><button id="compareClean" class="btn btn-outline btn-sm">DNA 成稿 → 去 AI 味稿</button></div><p class="compare-legend">红色删除线：原有文字；绿色：新文字。长稿按整句比较。</p><div id="compareOutput" class="compare-output"></div><details><summary>本篇历史版本</summary><div id="versionHistory"></div></details>';resultCard.append(comparisons);
  el('compareDna').onclick=()=>{compareMode='dna';renderDiff();};el('compareClean').onclick=()=>{compareMode='clean';renderDiff();};
  comparisons.addEventListener('toggle',()=>{if(comparisons.open){renderDiff();renderHistory();}});
  const tools=el('backupProject').parentElement;document.querySelector('main.main').append(tools);tools.querySelector('.muted-note').textContent='DNA、作者素材、所选组合与文稿版本自动存到本地工作目录；备份不含密钥。';
  document.querySelector('.spoken-hero').insertAdjacentHTML('afterend','<div class="workspace-process" aria-label="工作台处理流程"><span><b>01</b> 按 DNA 成稿</span><i>→</i><span><b>02</b> 去 AI 味</span></div>');
  resultCard.before(cleanControls);resultCard.before(Object.assign(node('div','workspace-divider'),{textContent:'稿件对照'}));
  const history=node('details','link-history');history.id='linkHistory';history.innerHTML='<summary id="linkHistorySummary">历史转写记录</summary><p class="muted-note">已保存或已收起的记录保留在这里，原稿与 DNA 不受影响。失败项仍可重试。</p><div id="linkHistoryQueue" class="link-queue"></div>';
  el('linkQueue').after(history);
  const archiveButton=button('收起已结束记录',()=>{archiveFinished();showToast('已收进历史记录，可继续导入新素材。','success');});el('refreshLinkJobs').after(archiveButton);
  function archivedIds(){return new Set([...app.archivedJobs,...app.library.flatMap(d=>(d.raw||[]).map(a=>a.sourceJobId).filter(Boolean))]);}
  function archiveFinished(ids){const rows=window.localImport.getJobs().filter(j=>['success','failed'].includes(j.status)&&(!ids||ids.has(j.id)));app.archivedJobs=[...new Set([...app.archivedJobs,...rows.map(j=>j.id)])];saveConfig();window.localImport.refreshJobs();}
  function dnaSaved(dna){archiveFinished(new Set((dna.raw||[]).map(a=>a.sourceJobId).filter(Boolean)));const s=app.authorSpaces[app.activeAuthor];if(s)s.savedDnaId=dna.id;el('builderFooterStatus').textContent='已保存「'+dna.name+'」。可关闭窗口，或添加下一位作者。';el('sidebarBuild').textContent='＋ 建立 / 添加 DNA';saveConfig();}

  function rememberAuthor(){
    const s=app.authorSpaces[app.activeAuthor];if(!s)return;
    s.articles=clone(state.articles);s.results=clone(state.distillResults);s.pendingProfile=clone(app.pendingProfile||null);s.name=el('authorName').value.trim();s.style=el('dnaStyleName').value.trim();s.savedName=el('dnaLibraryName').value;s.batchInput=el('batchInput').value;s.shareLinksInput=el('shareLinksInput').value;
  }
  function loadAuthor(key){
    const s=app.authorSpaces[key];if(!s)return;app.activeAuthor=key;state.articles=clone(s.articles||[]);state.distillResults=clone(s.results||emptyResults());app.pendingProfile=clone(s.pendingProfile||null);
    el('authorName').value=s.name||'';app.author=s.name||'';el('dnaStyleName').value=s.style||'';el('dnaLibraryName').value=s.savedName||s.name||'';
    el('batchInput').value=s.batchInput||'';el('shareLinksInput').value=s.shareLinksInput||'';
    el('resultCard').style.display=state.distillResults.dna?'block':'none';el('distillProgressCard').style.display='none';el('profileReport').replaceChildren();
    if(state.distillResults.dna)renderResults();renderArticleList();renderAuthors();
  }
  function busy(){return cleanupBusy||window.dnaV2.busy||!el('requestActivity').hidden;}
  function switchAuthor(key){if(busy())return showToast('请等当前处理完成后再切换作者。','info');rememberAuthor();loadAuthor(key);saveConfig();}
  function createAuthor(name=''){const key=uid('author');app.authorSpaces[key]={name:name.trim(),articles:[],results:emptyResults(),pendingProfile:null,style:''};return key;}
  el('referenceAuthor').onchange=()=>switchAuthor(el('referenceAuthor').value);
  el('createAuthor').onclick=()=>{if(busy())return;const key=createAuthor(el('newAuthorName').value);el('newAuthorName').value='';switchAuthor(key);};
  el('authorName').addEventListener('input',()=>{rememberAuthor();renderAuthors();});el('dnaStyleName').addEventListener('input',()=>{rememberAuthor();saveConfig();});
  for(const id of ['batchInput','shareLinksInput','dnaLibraryName'])el(id).addEventListener('input',()=>saveConfig());
  el('nextDnaAuthor').onclick=()=>{if(busy())return showToast('请等当前处理完成。','info');archiveFinished();const key=createAuthor();switchAuthor(key);el('builderFooterStatus').textContent='新的作者分组已就绪。上一位素材和转写记录已保留。';el('modeLinks').click();el('dnaBuilderBody').scrollTop=0;showToast('可以粘贴下一位作者的链接。上一位资料已保留。','success');};
  el('builderNextAuthor').onclick=()=>el('nextDnaAuthor').click();
  el('nextDnaAuthor').textContent='＋ 开始下一位作者（保留当前素材）';
  function renderAuthors(){
    const choose=el('referenceAuthor'),target=el('linkAuthorTarget'),wanted=target.value;choose.replaceChildren();target.replaceChildren();option(target,'auto','按识别到的作者自动归类');
    for(const [key,s]of Object.entries(app.authorSpaces)){const label=(s.name||'待确认作者')+' · '+(key===app.activeAuthor?state.articles.length:(s.articles||[]).length)+' 篇';option(choose,key,label);option(target,key,'全部归入：'+(s.name||'待确认作者'));}
    choose.value=app.activeAuthor;target.value=[...target.options].some(o=>o.value===wanted)?wanted:'auto';
    const s=app.authorSpaces[app.activeAuthor];el('authorSpaceNote').textContent=s?.name?'正在整理「'+s.name+'」的素材。其他作者的文章和分析会分别保留。':'此组作者尚未确认。请核对链接是否来自同一人；可给分组命名，或把文章移到其他作者。';
    const n=window.dnaV2.uniqueArticles(state.articles).length;el('buildGuideTitle').textContent='当前作者：'+n+' 篇不重复原稿';el('buildGuideText').textContent=n>=5?'可以点击“建立表达 DNA”，分析完成后保存。':'再加入 '+(5-n)+' 篇即可建立初步 DNA。';
  }
  function hasJob(job){return [state.articles,...Object.values(app.authorSpaces).map(s=>s.articles||[])].flat().some(a=>a.sourceJobId===job.id||a.sourceKey===job.key||a.sourceUrl===job.originalUrl);}
  function addArticle(article){
    if(hasJob({id:article.sourceJobId,key:article.sourceKey,originalUrl:article.sourceUrl}))return false;
    const explicit=el('linkAuthorTarget').value;let key;
    if(explicit!=='auto'&&app.authorSpaces[explicit])key=explicit;
    else if(article.authorName){key='platform-'+window.dnaV2.fingerprint((article.platform||'')+':'+(article.authorId||article.authorName));if(!app.authorSpaces[key])app.authorSpaces[key]={name:article.authorName,articles:[],results:emptyResults(),style:'',platform:article.platform,authorId:article.authorId||''};}
    else {key=Object.keys(app.authorSpaces).find(k=>app.authorSpaces[k].unconfirmed&&!app.authorSpaces[k].name);if(!key){key=uid('unconfirmed');app.authorSpaces[key]={name:'',articles:[],results:emptyResults(),style:'',unconfirmed:true};}}
    const group=app.authorSpaces[key];article={...article,authorKey:key,authorName:group.name||article.authorName||'',authorConfirmed:explicit!=='auto'||!!article.authorId};
    if(key===app.activeAuthor)state.articles.push(article);else group.articles.push(article);
    app.lastImportedAuthor=key;return true;
  }
  function jobsUpdated(jobs){const archived=archivedIds(),visible=jobs.filter(j=>!archived.has(j.id)||!['success','failed'].includes(j.status));for(const j of jobs){const card=document.querySelector('[data-job-id="'+j.id+'"]');const target=archived.has(j.id)&&['success','failed'].includes(j.status)?el('linkHistoryQueue'):el('linkQueue');if(card&&card.parentElement!==target)target.append(card);}const old=jobs.length-visible.length;el('linkHistorySummary').textContent='历史转写记录 · '+old+' 条';history.hidden=!old;const pending=visible.filter(j=>j.status==='success'&&!hasJob(j)),n=pending.length,unknown=pending.filter(j=>!j.authorName).length;el('addSuccessfulLinks').disabled=!n;el('addSuccessfulLinks').textContent=n?'将 '+n+' 条成功项加入文章库':'成功项已加入，或尚无成功结果';el('linkBulkHint').textContent=unknown?'有 '+unknown+' 条未返回作者。可在右侧选定作者批量归入；混合作者时请先分批确认，自动模式会放入待确认分组。':'成功结果可批量加入，无需复制；按接口明确返回的作者归类，昵称相同但无账号编号时请核对。';}
  el('addSuccessfulLinks').onclick=async()=>{const b=el('addSuccessfulLinks');b.disabled=true;try{const count=await window.localImport.addSuccessful();if(app.lastImportedAuthor)switchAuthor(app.lastImportedAuthor);showToast('已加入 '+count+' 篇，按作者分组。接下来建立当前作者的 DNA。','success');}catch(e){showToast(e.message,'error');}finally{jobsUpdated(window.localImport.getJobs());}};
  el('goAnalyzeArticles').onclick=()=>{if(app.lastImportedAuthor)switchAuthor(app.lastImportedAuthor);el('startDistillBtn').scrollIntoView({behavior:'smooth',block:'center'});showToast('每位作者至少 5 篇不重复原稿，再点击“建立表达 DNA”。','info');};
  const oldArticles=renderArticleList;
  renderArticleList=function(){oldArticles();if(!el('referenceAuthor'))return;rememberAuthor();renderAuthors();
    el('articleList').querySelectorAll('.article-item').forEach((row,i)=>{const select=node('select','article-author');select.setAttribute('aria-label','文章归属作者');for(const [key,s]of Object.entries(app.authorSpaces))option(select,key,s.name||'待确认作者');select.value=app.activeAuthor;select.onchange=()=>{if(busy())return;const [a]=state.articles.splice(i,1),dest=app.authorSpaces[select.value];if(!a||!dest)return;dest.articles.push({...a,authorName:dest.name,authorKey:select.value,authorConfirmed:true});saveConfig();renderArticleList();};row.insertBefore(select,row.querySelector('.article-edit'));});
  };

  function setModule(key,id){if(!Object.hasOwn(MODULES,key))return;if(id)app.dnaSelection[key]=id;else delete app.dnaSelection[key];const ids=Object.values(selection());app.selected=ids[0]||'';saveConfig();renderLibrary();}
  function selectWhole(dna){app.dnaSelection=Object.fromEntries(available(dna).map(k=>[k,dna.id]));app.selected=dna.id;saveConfig();renderLibrary();}
  const oldLibrary=renderLibrary;
  renderLibrary=function(){oldLibrary();if(!el('compositionSlots'))return;
    const selected=selection();const slots=el('compositionSlots');slots.replaceChildren();for(const [k,title]of Object.entries(MODULES)){const row=node('div','composition-slot');row.dataset.module=k;row.append(node('strong','',title.replace(' DNA','')),node('span','',dnaById(selected[k])?.name||'未选 · 按你的内容自然表达'));if(selected[k])row.append(button('×',()=>setModule(k,''),''));slots.append(row);}
    el('structureChoice').disabled=!selected.structure;if(!selected.structure)el('structureHint').textContent='未选择结构 DNA，本次按你的内容自然组织；仍可借用其他已选类型。';
    el('sidebarSelectionLabel').textContent=selectionLabel();el('writingComposition').textContent=Object.entries(selected).map(([k,id])=>MODULES[k]+'：'+dnaById(id).name).join('；')||'还没有选择 DNA。先建立一份，或在左侧导入已有 DNA。';
    const filter=el('dnaStyleFilter'),styleValue=filter.value;filter.replaceChildren();option(filter,'','全部风格');for(const s of [...new Set(app.library.map(d=>d.style).filter(Boolean))])option(filter,s,s);filter.value=styleValue;
    const list=el('dnaChoices');list.replaceChildren();const search=el('dnaSearch').value.trim().toLowerCase();const choices=[...app.library,...(Object.values(selected).includes(DEMO.id)?[DEMO]:[])].filter(d=>(!filter.value||d.style===filter.value)&&(!search||(d.name+' '+(d.authorName||'')+' '+(d.style||'')).toLowerCase().includes(search)));
    if(!choices.length)list.append(node('p','muted-note',app.library.length?'没有匹配的 DNA。':'还没有保存的 DNA。先从右侧导入素材建立，或在下方导入文档。'));
    for(const d of choices){const item=node('div','dna-library-item'),whole=button(d.name,()=>selectWhole(d),'dna-choice'+(Object.values(selected).includes(d.id)?' selected':''));whole.dataset.dnaId=d.id;whole.setAttribute('aria-pressed',String(Object.values(selected).includes(d.id)));whole.append(node('small','',d.demo?'人工编写的体验示例':(d.style?d.style+' · ':'')+(d.authorName||'参考作者')+' · '+(d.raw?.length||0)+' 篇原稿'));item.append(whole);
      const sub=node('div','module-options');for(const k of available(d)){const label=node('label'),check=node('input');check.type='checkbox';check.dataset.module=k;check.dataset.dnaId=d.id;check.checked=selected[k]===d.id;check.onchange=()=>setModule(k,check.checked?d.id:'');label.append(check,node('span','',MODULES[k]));if(!profile(d))label.append(node('small','','待整理'));sub.append(label);}item.append(sub);
      if(!d.demo){const detail=node('details');detail.append(node('summary','','风格标签与原始 DNA'));const input=node('input');input.value=d.style||'';input.placeholder='风格标签';input.setAttribute('aria-label',d.name+'的风格标签');input.onchange=()=>{d.style=input.value.trim();saveConfig();renderLibrary();};detail.append(input,node('pre','',d.text));item.append(detail);}list.append(item);
    }
    const saved=el('savedCombinations'),savedValue=saved.value;saved.replaceChildren();option(saved,'','选择已保存的组合');for(const c of app.combinations)option(saved,c.id,c.name);saved.value=savedValue;
  };
  el('dnaSearch').oninput=()=>renderLibrary();el('dnaStyleFilter').onchange=()=>renderLibrary();
  el('saveCombination').onclick=()=>{const selected=selection();if(!Object.keys(selected).length)return showToast('先选择至少一类 DNA。','error');const name=el('combinationName').value.trim()||selectionLabel();const existing=app.combinations.find(c=>c.name===name);if(existing)existing.selection=selected;else app.combinations.push({id:uid('combination'),name,selection:selected});saveConfig();renderLibrary();showToast('组合已保存，下次可以直接选择。','success');};
  el('savedCombinations').onchange=()=>{const c=app.combinations.find(c=>c.id===el('savedCombinations').value);if(!c)return;app.dnaSelection=clone(c.selection);app.selected=Object.values(selection())[0]||'';saveConfig();renderLibrary();};
  async function material(story,intent,report){
    const chosen=clone(story.dnaSelection||selection()),ids=[...new Set(Object.values(chosen))],pieces=[];
    if(!ids.length)throw new Error('先选择至少一类 DNA。');
    for(const id of ids){const dna=dnaById(id);if(!dna)throw new Error('所选 DNA 已不存在，请重新选择。');report('正在读取「'+dna.name+'」的表达规则…');const p=await window.dnaV2.ensureProfile(dna,report);pieces.push({dna,p,m:window.dnaV2.chooseMaterial(dna,p,story.spoken+'\n'+story.supplements,intent,app.structureChoices[dna.id]||'auto')});}
    let structure=null;const rules=[],references=[],warnings=[],moduleSources=[];
    for(const [key,id]of Object.entries(chosen)){if(!Object.hasOwn(MODULES,key))continue;const part=pieces.find(p=>p.dna.id===id);if(!part)continue;const matching=key==='structure'?part.m.structure:part.m.rules.filter(r=>r.category===key);
      if(key==='structure')structure=matching||null;else for(const r of matching)rules.push({...r,source:part.dna.name});
      const count=key==='structure'?(matching?1:0):matching.length;moduleSources.push({category:key,label:MODULES[key],author:part.dna.authorName||part.dna.name,dnaId:id,name:part.dna.name,available:!!count});if(!count)warnings.push('「'+part.dna.name+'」暂无可用于本次内容的'+MODULES[key]+'，此类按你的内容自然组织。');
    }
    // 每个来源轮流取一篇，避免多个作者组合被单一来源挤满。
    for(let i=0;i<5;i++)for(const part of pieces){const r=part.m.references[i];if(r&&references.length<6)references.push({...r,id:part.dna.id+':'+r.id,source:part.dna.name});}
    for(const part of pieces)warnings.push(...part.m.warnings);
    return {structure,rules,references,warnings:[...new Set(warnings)],moduleSources,types:intent.types||['unknown'],reason:intent.reason||'',manual:false};
  }

  function snapshot(stage,text,meta={}){if(!text?.trim())return;const last=app.revisions[app.revisions.length-1];if(last?.stage===stage&&last.text===text)return;app.revisions.push({id:uid('version'),stage,text,createdAt:new Date().toISOString(),...clone(meta)});}
  const oldShow=showResult;
  showResult=function(text,note){
    if(app.result&&app.result!==text)snapshot('DNA 成稿',app.result,{composition:app.lastDraftComposition||''});
    if(app.cleanup?.text)snapshot('去 AI 味稿',app.cleanup.text,{source:app.cleanup.source});
    app.cleanup=null;app.lastDraftComposition=app.generationSource?.combinationName||selectionLabel();
    const source=app.generationSource||{spoken:app.spoken,supplements:app.supplements};snapshot('原始口述',source.spoken+(source.supplements?'\n\n补充：\n'+source.supplements:''));snapshot('DNA 成稿',text,{composition:app.lastDraftComposition});oldShow(text,note);renderJourney();
  };
  function renderJourney(){
    if(!el('sourceVersionText'))return;resultCard.hidden=!app.result&&!app.cleanup?.text&&!app.spoken;
    const source=app.generationSource||{spoken:app.spoken,supplements:app.supplements};el('sourceVersionText').textContent=source.spoken+(source.supplements?'\n\n补充：\n'+source.supplements:'')||'先在第二步讲讲你想表达的内容。';
    el('sourceVersionCaption').textContent=app.generationSource?'生成这版稿件时保存的原话，后续输入不会改掉这份记录。':'尚未生成，当前显示输入中的原话。';
    el('dnaVersionCaption').textContent=(app.lastDraftComposition||app.generationSource?.combinationName||'尚未生成')+' · 可直接编辑';
    el('sendCleanup').disabled=!app.result.trim()||cleanupBusy;
    if(app.cleanup?.text){el('deaiOutput').textContent=app.cleanup.text;el('deaiOutput').classList.remove('empty');el('deaiOutput').contentEditable='true';el('copyDeaiBtn').disabled=false;el('cleanVersionCaption').textContent=(app.cleanup.fromDraft?(app.cleanup.source===app.result?'对应当前 DNA 稿':'DNA 稿已修改，此版仍对应上次清理的文字'):'独立清理的文字，以待清理输入为准')+' · 可直接编辑';}
    else {el('deaiOutput').textContent='DNA 成稿后，点击“直接去 AI 味”。这一版会单独保留。';el('deaiOutput').classList.add('empty');el('deaiOutput').contentEditable='false';el('copyDeaiBtn').disabled=true;el('cleanVersionCaption').textContent='等待清理，原始口述和 DNA 成稿都会保留。';}
    if(app.result&&!el('deaiInput').value){el('deaiInput').value=app.result;el('deaiInput').dispatchEvent(new Event('input'));}
    if(comparisons.open){renderDiff();renderHistory();}
  }
  el('spokenInput').addEventListener('input',renderJourney);el('spokenResult').addEventListener('input',()=>{renderJourney();saveConfig();});
  el('deaiOutput').addEventListener('input',()=>{if(app.cleanup){app.cleanup.text=el('deaiOutput').innerText;saveConfig();}});
  const oldCleanupPrompt=buildDeaiSystemPrompt;
  buildDeaiSystemPrompt=async function(){return window.projectSkills.text('deai-edit','system',{strictInstruction:await window.projectSkills.text('deai-edit',state.strictMode?'strict':'relaxed'),expressionRules:JSON.stringify((app.lastMaterial?.rules||[]).map(r=>({category:r.category,text:r.text,condition:r.condition})))});};
  const oldCleanButton=el('startDeaiBtn');oldCleanButton.replaceWith(oldCleanButton.cloneNode(true));
  el('startDeaiBtn').textContent='开始去 AI 味';
  async function cleanup(fromDraft){
    if(cleanupBusy||!el('requestActivity').hidden)return showToast('请等当前处理完成。','info');syncApiFromInputs();
    const text=(fromDraft?app.result:el('deaiInput').value).trim();if(!text)return showToast('请先生成 DNA 成稿，或展开下方输入其他文案。','error');
    if(!state.apiKey){window.appSettings.open();return showToast('请先保存写作模型配置。','error');}
    cleanupBusy=true;el('deaiInput').value=text;activate('deai');el('startDeaiBtn').disabled=true;el('startDeaiBtn').textContent='正在去 AI 味…';el('sendCleanup').disabled=true;
    try{
      const response=await callAPI([{role:'system',content:await buildDeaiSystemPrompt()},{role:'user',content:text}],Math.min(10000,Math.max(1800,countWords(text)*3+500)));
      const match=response.match(/(?:^|\n)\s*(\[\s*(?:\{[\s\S]*\}\s*)?\])\s*$/),stats=match?JSON.parse(match[1]):[];if(!Array.isArray(stats)||stats.some(s=>!s||typeof s.rule!=='string'||!Number.isFinite(s.count)))throw new Error('清理统计格式不完整，请重试。');const clean=(match?response.slice(0,match.index):response).trim();if(!clean)throw new Error('清理返回空稿件，原有版本已保留。');
      if(app.cleanup?.text)snapshot('去 AI 味稿',app.cleanup.text,{source:app.cleanup.source});snapshot(fromDraft?'DNA 成稿':'待清理原文',text,{composition:fromDraft?app.lastDraftComposition||'':''});
      app.cleanup={text:clean,source:text,fromDraft:!!fromDraft,createdAt:new Date().toISOString(),stats};snapshot('去 AI 味稿',clean,{source:text,composition:app.lastDraftComposition||''});
      el('deaiStatsGrid').replaceChildren();for(const s of stats){const row=node('div','stat-item');row.append(node('span','stat-item-name',String(s.rule||'')),node('span','stat-item-count',String(s.count||0)+' 处'));el('deaiStatsGrid').append(row);}el('deaiStatsPanel').style.display=stats.length?'block':'none';saveConfig();showToast('去 AI 味稿已单独保存，可对照三版内容。','success');
    }catch(e){showToast('清理失败：'+e.message+' 已有稿件保留。','error');}
    finally{cleanupBusy=false;el('startDeaiBtn').disabled=false;el('startDeaiBtn').textContent='开始去 AI 味';renderJourney();}
  }
  el('startDeaiBtn').onclick=()=>cleanup(false);el('sendCleanup').onclick=()=>cleanup(true);
  function diff(a,b){
    let aa=[...a],bb=[...b];if(aa.length>1600||bb.length>1600){aa=a.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g)||[];bb=b.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g)||[];}
    if(aa.length*bb.length>1000000)return [{kind:'del',text:a},{kind:'ins',text:b}];
    const width=bb.length+1,table=new Uint16Array((aa.length+1)*width);for(let i=aa.length-1;i>=0;i--)for(let j=bb.length-1;j>=0;j--)table[i*width+j]=aa[i]===bb[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    const out=[];function emit(kind,text){if(out.at(-1)?.kind===kind)out.at(-1).text+=text;else out.push({kind,text});}let i=0,j=0;while(i<aa.length||j<bb.length){if(i<aa.length&&j<bb.length&&aa[i]===bb[j]){emit('span',aa[i++]);j++;}else if(j<bb.length&&(i===aa.length||table[i*width+j+1]>=table[(i+1)*width+j]))emit('ins',bb[j++]);else emit('del',aa[i++]);}return out;
  }
  function renderDiff(){const box=el('compareOutput');box.replaceChildren();const source=app.generationSource||{spoken:app.spoken,supplements:app.supplements},a=compareMode==='dna'?source.spoken+(source.supplements?'\n\n'+source.supplements:''):app.cleanup?.source||app.result,b=compareMode==='dna'?app.result:app.cleanup?.text||'';if(!b){box.textContent='完成这一阶段后即可查看变化。';return;}for(const piece of diff(a,b))box.append(node(piece.kind,'',piece.text));}
  function renderHistory(){const box=el('versionHistory');box.replaceChildren();for(const r of [...app.revisions].reverse()){const d=node('details','revision-row');d.append(node('summary','',r.stage+' · '+new Date(r.createdAt).toLocaleString('zh-CN')+(r.composition?' · '+r.composition:'')),node('pre','',r.text));box.append(d);}}

  function setSaveStatus(message,error=false){el('workbenchSaveStatus').textContent=message;el('workbenchSaveStatus').classList.toggle('error',error);}
  function workspacePayload(){rememberAuthor();const clean=window.localImport.cleanBackup({app:{...app},articles:state.articles,distillResults:state.distillResults});delete clean.app.library;return clean;}
  async function api(path,method='GET',body){const res=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Spoken-DNA':'local'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();if(!res.ok){const e=new Error(data.error||'本地工作区操作失败。');e.status=res.status;throw e;}return data;}
  function scheduleSave(){if(restoring||!diskReady||diskConflict)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(()=>{}),650);}
  async function flush(){
    clearTimeout(saveTimer);if(restoring||!diskReady||diskConflict)return saveChain;const folder=diskFolder,payload=workspacePayload();
    const task=saveChain.catch(()=>{}).then(async()=>{if(folder!==window.dnaDisk.workspaceDirectory)return;setSaveStatus('正在保存素材、组合和文稿版本…');const r=await api('/api/workbench','PUT',{state:payload,revision:diskRevision,workspaceDirectory:folder});diskRevision=r.revision;setSaveStatus('素材、所选组合与文稿版本已保存到本地。');});
    saveChain=task.catch(e=>{if(e.status===409)diskConflict=true;setSaveStatus(e.message,true);throw e;});return saveChain;
  }
  const previousSave=saveConfig;
  saveConfig=function(){if(!restoring)rememberAuthor();previousSave();scheduleSave();};
  const previousExample=el('tryExample').onclick;
  el('tryExample').onclick=()=>{previousExample();if(app.selected===DEMO.id){selectWhole(DEMO);app.lastDraftComposition=DEMO.name;renderJourney();saveConfig();}};
  async function hydrateWorkspace(){
    const folder=window.dnaDisk.workspaceDirectory;if(!folder){setSaveStatus('选择本地工作目录后，素材、组合与文稿版本会一起记住。');return;}
    if(loadingFolder||folder===diskFolder)return;loadingFolder=true;restoring=true;diskReady=false;
    try{await saveChain.catch(()=>{});const data=await api('/api/workbench');diskRevision=data.revision;diskFolder=folder;diskConflict=false;
      if(data.exists){const saved=data.state;if(!saved?.app||!Array.isArray(saved.articles))throw new Error('工作区资料不完整，浏览器资料已保留。');const library=app.library;Object.assign(app,saved.app);app.library=library;state.articles=saved.articles;state.distillResults=saved.distillResults||emptyResults();normalizeApp();}
      loadAuthor(app.activeAuthor);el('spokenInput').value=app.spoken||'';el('supplementInput').value=app.supplements||'';el('spokenDuration').value=app.duration||'60';el('spokenResult').textContent=app.result||'';el('questionBox').hidden=!app.questions?.length;renderQuestions();
      renderLibrary();renderJourney();window.dnaV2.renderReview();if(app.lastMaterial)window.dnaV2.renderMaterials(app.lastMaterial);diskReady=true;setSaveStatus(data.exists?'已从本地恢复作者素材、DNA 组合与文稿版本。':'首次连接：将保存当前素材、DNA 组合与文稿版本。');previousSave();
    }catch(e){setSaveStatus(e.message,true);}finally{restoring=false;loadingFolder=false;activate('write');if(diskReady)scheduleSave();}
  }
  window.dnaFlow={selection,selectionLabel,selectWhole,material,hasJob,addArticle,jobsUpdated,flush,diff,navigate,dnaSaved,isArchived:id=>archivedIds().has(id),activateImported:()=>{if(app.lastImportedAuthor)switchAuthor(app.lastImportedAuthor);},
    restoreInputs:()=>{normalizeApp();loadAuthor(app.activeAuthor);el('spokenInput').value=app.spoken||'';el('supplementInput').value=app.supplements||'';el('spokenResult').textContent=app.result||'';renderJourney();},
    metadata:()=>({authorName:el('authorName').value.trim(),authorKey:app.activeAuthor,style:el('dnaStyleName').value.trim(),createdAt:new Date().toISOString()}),
    get ready(){return !restoring;},get diskReady(){return diskReady;}};
  const reloadLibrary=window.dnaDisk.reload;
  window.dnaDisk.reload=async()=>{await reloadLibrary();await hydrateWorkspace();};
  // 选择目录在原模块中完成；观察实际连接后的只读路径值，不开启第二个选择器。
  el('chooseWorkspace').addEventListener('click',()=>{const timer=setInterval(()=>{if(!el('chooseWorkspace').disabled){clearInterval(timer);hydrateWorkspace();}},200);});
  window.addEventListener('pagehide',()=>{if(diskReady&&!diskConflict&&!restoring){const body=JSON.stringify({state:workspacePayload(),revision:diskRevision,workspaceDirectory:diskFolder});fetch('/api/workbench',{method:'PUT',headers:{'Content-Type':'application/json','X-Spoken-DNA':'local'},body,keepalive:true}).catch(()=>{});}});
  // 旧的作者素材和稿件先保留在浏览器，再按选定目录读取或迁入。
  loadAuthor(app.activeAuthor);restoring=false;renderLibrary();renderJourney();activate('write');
  Promise.resolve(window.appSettings.ready).then(async()=>{await reloadLibrary();await hydrateWorkspace();});
})();

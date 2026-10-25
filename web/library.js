/* 磁盘 DNA 为真源；浏览器继续缓存工作区和文稿，不因读取失败清空原资料。 */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let configured=false,ready=false,directory='',locations={},timer=null,loading=false,generation=0;
  let savedFingerprint='',chain=Promise.resolve();
  const fingerprint=()=>JSON.stringify(app.library);
  async function api(path,method='GET',body){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),path==='/api/workspace/choose'?180000:15000);
    try{
      const res=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Spoken-DNA':'local'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'DNA 目录操作失败。');return data;
    }catch(e){if(e instanceof TypeError)throw new Error('无法连接本地 DNA 服务，浏览器缓存已保留。');if(e.name==='AbortError')throw new Error('DNA 保存或读取超时，浏览器缓存已保留。');throw e;}
    finally{clearTimeout(timeout);}
  }
  el('apiPanel').insertAdjacentHTML('beforeend',`<section class="local-config workspace-section" aria-label="本地工作目录">
    <div class="card-title" style="font-size:15px;margin-bottom:12px">本地工作目录</div>
    <div class="form-group"><label for="dnaDirectory">DNA 和配置统一保存在这里</label><div class="workspace-picker-row"><input id="dnaDirectory" readonly placeholder="尚未选择工作目录" aria-label="已选择的本地工作目录"><button id="chooseWorkspace" class="btn btn-outline">选择文件夹…</button></div><small>选一次，之后自动读取。DNA、普通配置和加密密钥分开保存，不需要每次重输。</small></div>
    <div class="toolbar" style="margin-top:12px"><button id="reloadDnaDirectory" class="btn btn-outline btn-sm">重新读取</button><button id="openDnaDirectory" class="btn btn-outline btn-sm">打开工作目录</button></div>
    <p id="dnaDirectoryStatus" class="muted-note" role="status">正在读取本地资料…</p><small>固定结构：DNA 文件夹、config.json 普通配置、credentials.dpapi 加密密钥。切换目录保留原文件。</small>
  </section>`);
  el('dnaChoices').before(Object.assign(document.createElement('div'),{id:'dnaDiskNotice',className:'notice'}));
  el('dnaChoices').after(Object.assign(document.createElement('p'),{id:'dnaDiskSummary',className:'muted-note'}));
  el('profileReport').insertAdjacentHTML('beforebegin','<p class="muted-note">每位博主请单独导入、分析并保存，避免混成同一份 DNA。</p>');
  el('linkImportPanel').insertAdjacentHTML('afterend','<div class="toolbar" style="margin-top:14px"><button class="btn btn-outline btn-sm" id="nextDnaAuthor">下一位博主</button><small class="link-notice" style="margin:0">先保存本位博主的 DNA，再开始下一位。</small></div>');
  const status=(message,error=false)=>{
    el('dnaDirectoryStatus').textContent=message;el('dnaDirectoryStatus').style.color=error?'var(--danger)':'var(--text-secondary)';
    el('dnaDiskSummary').textContent=message;
  };
  function notice(){
    el('dnaDiskNotice').hidden=configured;
    el('dnaDiskNotice').textContent=ready?'尚未选择本地工作目录。请打开右上角设置，点击“选择文件夹”。浏览器已有资料会保留。':'正在连接本地资料库…';
    el('openDnaDirectory').disabled=!configured;
  }
  function focusDirectory(){if(window.appSettings)window.appSettings.open();else el('apiPanel').classList.add('open');el('chooseWorkspace').focus();}
  el('dnaDiskNotice').onclick=focusDirectory;
  function enqueue(task){const result=chain.catch(()=>{}).then(task);chain=result;return result;}
  async function writeOne(dna){
    const result=await api('/api/library','PUT',{dna});locations[dna.id]=result.directory;return result;
  }
  async function flush(){
    clearTimeout(timer);
    if(!ready||!configured||loading)return;
    if(fingerprint()===savedFingerprint)return chain;
    const snapshot=structuredClone(app.library),key=JSON.stringify(snapshot);
    return enqueue(async()=>{
      status('正在保存 DNA 到本地目录…');
      for(const dna of snapshot)await writeOne(dna);
      savedFingerprint=key;status(`已连接 ${directory} · 本地保存 ${snapshot.length} 份 DNA`);
    }).catch(e=>{status(e.message,true);throw e;});
  }
  async function hydrate(data){
    loading=true;
    try{
      configured=data.configured&&!!data.workspaceDirectory;directory=data.workspaceDirectory||'';locations=data.locations||{};
      el('dnaDirectory').value=directory;
      if(!configured){status('请选择本地工作目录，DNA 和配置会分开存放在同一目录中。');return;}
      const ids=new Set(data.entries.map(d=>d.id));
      const unsaved=app.library.filter(d=>!ids.has(d.id));
      // 不让旧浏览器缓存覆盖目录里已有的同编号 DNA。
      for(const dna of unsaved)await enqueue(()=>writeOne(dna));
      app.library=[...data.entries,...unsaved];savedFingerprint=fingerprint();
      if(app.selected!==DEMO.id&&!app.library.some(d=>d.id===app.selected))app.selected=app.library[0]?.id||'';
      saveConfig();renderLibrary();
      status(`已连接 ${directory} · 本地保存 ${app.library.length} 份 DNA${unsaved.length?' · 已迁入浏览器原有 '+unsaved.length+' 份':''}${data.warnings?.length?' · '+data.warnings.join('；'):''}`,!!data.warnings?.length);
    }finally{loading=false;ready=true;notice();}
  }
  async function reload(){
    const current=++generation;
    try{await flush();const data=await api('/api/library');if(current===generation)await hydrate(data);}
    catch(e){configured=false;ready=true;notice();status(e.message,true);}
  }
  el('chooseWorkspace').onclick=async()=>{
    const btn=el('chooseWorkspace');btn.disabled=true;const previous=btn.textContent;btn.textContent='请选择文件夹…';
    const current=++generation;
    try{await flush();if(window.dnaFlow)await window.dnaFlow.flush();const data=await api('/api/workspace/choose','POST',{});if(data.cancelled)return;if(current===generation)await hydrate(data);if(data.config&&window.appSettings)window.appSettings.apply(data.config,{preservePending:true});showToast('工作目录已连接，配置和 DNA 会自动记住','success');}
    catch(e){status(e.message,true);showToast(e.message,'error');}finally{btn.disabled=false;btn.textContent=previous;}
  };
  el('reloadDnaDirectory').onclick=reload;
  el('openDnaDirectory').onclick=async()=>{try{await api('/api/library/open','POST',{});}catch(e){showToast(e.message,'error');}};
  const oldSave=saveConfig;
  saveConfig=function(){oldSave();if(ready&&configured&&!loading&&fingerprint()!==savedFingerprint){clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),600);}};
  const oldRender=renderLibrary;
  renderLibrary=function(){oldRender();const selected=selectedDna(),path=selected&&locations[selected.id];if(path){const p=document.createElement('p');p.className='muted-note';p.textContent='本地文件夹：'+path;el('selectedDnaInfo').append(p);}};
  document.addEventListener('click',event=>{
    const id=event.target.closest('button')?.id;
    if(['saveLibraryDna','importDnaBtn'].includes(id)&&(!ready||!configured)){
      event.preventDefault();event.stopImmediatePropagation();focusDirectory();showToast('请先选择本地工作目录，分析结果已保留。','error');
    }
  },true);
  el('nextDnaAuthor').onclick=()=>{
    if(!el('requestActivity').hidden)return showToast('请等本次模型处理完成后再切换博主。','info');
    if(!confirm('开始下一位博主？将清空当前原稿和分析显示，已保存到本地的 DNA 会保留。未保存的分析请先保存。'))return;
    state.articles=[];state.distillResults={dna:'',l1:'',l2:'',l35:'',l6:''};app.pendingProfile=null;
    el('authorName').value='';el('dnaLibraryName').value='';el('batchInput').value='';el('shareLinksInput').value='';
    el('resultCard').style.display='none';el('distillProgressCard').style.display='none';
    saveConfig();renderArticleList();showToast('可以导入下一位博主的素材，已保存的 DNA 保留','success');
  };
  window.dnaDisk={
    async save(dna){
      if(!ready||!configured){focusDirectory();throw new Error('请先在配置面板指定 DNA 本地保存目录。');}
      const result=await enqueue(()=>writeOne(dna));status('DNA 已写入：'+result.directory);return result;
    },flush,reload,get configured(){return configured;},get workspaceDirectory(){return directory;}
  };
  notice();reload();
})();

/* 统一保存设置；页面从不接收已保存密钥，写作请求也通过本地服务。 */
(() => {
  'use strict';
  const el=id=>document.getElementById(id),panel=el('apiPanel');
  let config=null,loaded=false,saving=null,active=null;
  const dialog=document.createElement('dialog');dialog.id='settingsDialog';dialog.className='config-dialog';dialog.setAttribute('aria-labelledby','settingsTitle');
  dialog.innerHTML='<header class="settings-heading"><div><h2 id="settingsTitle">本地设置</h2><p>选择一个工作目录，DNA 和配置分开保存，下次自动读取。</p></div><button id="closeSettings" class="btn-icon settings-close" aria-label="关闭设置">×</button></header>';
  dialog.append(panel);
  dialog.insertAdjacentHTML('beforeend','<footer class="settings-footer"><p id="settingsSaveStatus" class="settings-help" role="status">配置只保存在本机，密钥由当前 Windows 用户加密。</p><div class="settings-footer-actions"></div></footer>');
  document.body.append(dialog);
  const workspace=panel.querySelector('.workspace-section');panel.prepend(workspace);
  const grid=panel.querySelector('.api-grid'),writing=document.createElement('section');writing.className='settings-section';
  writing.innerHTML='<h3 class="settings-section-title">写作模型</h3><p class="settings-help">用于 DNA 分析、口述成稿、成稿核对和去 AI 味。保存一次即可，下次不用重输 Key。</p>';
  grid.before(writing);writing.append(grid);
  el('apiKey').insertAdjacentHTML('afterend','<small id="writingKeyStatus" class="settings-key-status"></small>');
  function replaceButton(id){const old=el(id),next=old.cloneNode(true);old.replaceWith(next);return next;}
  const save=replaceButton('saveApiBtn');save.textContent='保存全部配置';dialog.querySelector('.settings-footer-actions').append(save);
  const test=replaceButton('testApiBtn');test.textContent='测试写作连接';
  el('saveLinkConfig').remove();el('refreshLinkConfig').remove();
  const forget=replaceButton('forgetLinkKeys');forget.textContent='清除保存的密钥';
  const interval=el('asrInterval').closest('.form-group'),advanced=document.createElement('details');advanced.className='settings-advanced';
  advanced.innerHTML='<summary>高级：批量转写请求间隔</summary>';advanced.append(interval);panel.querySelector('[aria-label="视频转文字配置"]').append(advanced);
  const toggle=replaceButton('toggleApiPanel');toggle.title='本地设置';toggle.setAttribute('aria-label','打开设置');
  let previousFocus=null;
  function open(){previousFocus=document.activeElement;if(!dialog.open)dialog.showModal();if(!panel.classList.contains('open'))panel.classList.add('open');}
  function close(){if(dialog.open)dialog.close();panel.classList.remove('open');previousFocus?.focus?.();}
  toggle.onclick=open;el('closeSettings').onclick=close;
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))close();});
  dialog.addEventListener('close',()=>panel.classList.remove('open'));
  new MutationObserver(()=>{if(panel.classList.contains('open')&&!dialog.open)open();}).observe(panel,{attributes:true,attributeFilter:['class']});

  async function api(path,method='GET',payload,signal){
    const res=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Spoken-DNA':'local'},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal});
    const data=await res.json();if(!res.ok)throw new Error(data.error||'本地配置请求失败，请重试。');return data;
  }
  function setModel(model){const known=[...el('apiModel').options].some(o=>o.value===model);el('apiModel').value=known?model:'custom';el('apiModelCustom').style.display=known?'none':'block';el('apiModelCustom').value=known?'':model;}
  function setStatus(message,error=false){el('settingsSaveStatus').textContent=message;el('settingsSaveStatus').classList.toggle('settings-error',error);}
  function apply(c,{preservePending=false}={}){
    const pending=preservePending?Object.fromEntries(['apiKey','asrKey','parserToken'].filter(id=>el(id).value.trim()).map(id=>[id,el(id).value])):{};
    const pendingWriting=preservePending&&config&&(el('apiBase').value.trim()!==config.writingBase||getCurrentModel()!==config.writingModel)?{base:el('apiBase').value,model:getCurrentModel()}:null;
    const pendingInterval=preservePending&&config&&Number(el('asrInterval').value)!==config.asrInterval?el('asrInterval').value:null;
    config=c;loaded=true;
    state.apiBase=c.writingBase||state.apiBase;state.apiModel=c.writingModel||state.apiModel;
    el('apiBase').value=state.apiBase;setModel(state.apiModel);
    ['apiKey','asrKey','parserToken'].forEach(id=>el(id).value='');
    el('apiKey').placeholder=c.writingConfigured?'已保存，留空保留':'填写写作模型 API Key';
    el('asrKey').placeholder=c.asrConfigured?'已保存，留空保留':'填写硅基流动 API Key';
    el('parserToken').placeholder=c.parserConfigured?'已保存，留空保留':'填写起零数据 Token';
    el('writingKeyStatus').textContent=c.writingConfigured?'已保存，下次自动使用':'尚未配置';
    window.linkConfig?.apply(c);
    for(const [id,value]of Object.entries(pending))el(id).value=value;
    if(pendingWriting){el('apiBase').value=pendingWriting.base;setModel(pendingWriting.model);}
    if(pendingInterval!==null)el('asrInterval').value=pendingInterval;
    state.apiKey=c.writingConfigured?'__local_saved_writing_key__':'';
    updateApiStatus();updateDistillButton();el('deaiInput').dispatchEvent(new Event('input'));
    setStatus(c.warning||(c.workspaceDirectory?'已连接工作目录。保存后配置和密钥会自动记住。':'请先点击“选择文件夹”，已有转写凭据会自动沿用。'),!!c.warning);
  }
  syncApiFromInputs=function(){
    state.apiBase=el('apiBase').value.trim()||'https://api.deepseek.com/v1';state.apiModel=getCurrentModel()||'deepseek-chat';
    state.apiKey=(el('apiKey').value.trim()||config?.writingConfigured)?'__local_saved_writing_key__':'';
    updateApiStatus();
  };
  function dirty(){return !config||['apiKey','asrKey','parserToken'].some(id=>el(id).value.trim())||el('apiBase').value.trim()!==config.writingBase||getCurrentModel()!==config.writingModel||Number(el('asrInterval').value)!==config.asrInterval;}
  async function persist(){
    if(saving)return saving;
    if(!window.dnaDisk?.workspaceDirectory){open();el('chooseWorkspace').focus();throw new Error('请先点击“选择文件夹”，选择保存 DNA 和配置的工作目录。');}
    const payload={writingKey:el('apiKey').value.trim(),writingBase:el('apiBase').value.trim(),writingModel:getCurrentModel()||'deepseek-chat',asrKey:el('asrKey').value.trim(),parserToken:el('parserToken').value.trim(),asrInterval:Number(el('asrInterval').value),remember:true,requireWorkspace:true};
    save.disabled=true;setStatus('正在加密保存配置…');
    saving=api('/api/config','PUT',payload).then(c=>{apply(c);setStatus('配置已保存。下次启动自动读取，无需重复输入。');return c;}).catch(e=>{setStatus(e.message,true);throw e;}).finally(()=>{save.disabled=false;saving=null;});
    return saving;
  }
  save.onclick=async()=>{try{await persist();showToast('全部配置已保存，下次自动读取','success');close();}catch(e){showToast(e.message,'error');}};
  test.onclick=async()=>{
    test.disabled=true;
    try{if(dirty())await persist();const result=await api('/api/writing','POST',{messages:[{role:'user',content:'ping'}],max_tokens:5});if(!result.choices?.length)throw new Error('接口未返回结果。');showToast('写作模型连接成功','success');}
    catch(e){setStatus(e.message,true);showToast(e.message,'error');}finally{test.disabled=false;}
  };
  forget.onclick=async()=>{if(!confirm('清除工作目录中记住的写作、语音识别和起零数据密钥？DNA 和普通配置会保留。'))return;try{apply(await api('/api/config','PUT',{forget:true}));showToast('已清除保存的密钥','success');}catch(e){showToast(e.message,'error');}};
  ['apiKey','apiBase','apiModel','apiModelCustom'].forEach(id=>el(id).addEventListener('input',()=>{syncApiFromInputs();updateDistillButton();}));
  callAPI=async function(messages,maxTokens){
    await ready;
    if(active)throw new Error('已有请求处理中，请等它完成或点击停止。');
    if(dirty())await persist();
    if(!config?.writingConfigured){open();throw new Error('请在设置里保存写作模型 API Key。');}
    const controller=new AbortController();active=controller;let cancelled=false;
    const started=Date.now();el('requestActivity').hidden=false;
    const tick=()=>el('requestActivityText').textContent=`正在等待写作接口，已等待 ${Math.floor((Date.now()-started)/1000)} 秒；可以停止，已完成内容会保留。`;
    tick();const clock=setInterval(tick,1000),timeout=setTimeout(()=>controller.abort(),300000);
    el('cancelRequest').onclick=()=>{cancelled=true;controller.abort();};
    try{
      const data=await api('/api/writing','POST',{messages,max_tokens:maxTokens||6000},controller.signal),choice=data.choices?.[0];
      if(choice?.finish_reason==='length')throw new Error('模型输出被截断，已有内容已保留。请缩短材料或调整写作模型后重试。');
      if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw new Error('写作接口未返回有效文本，请检查模型设置。');
      return choice.message.content;
    }catch(e){if(e.name==='AbortError')throw new Error(cancelled?'已停止本次处理，已有内容已保留。':'写作接口等待超过 5 分钟，已有内容已保留。');if(e instanceof TypeError)throw new Error('未能连接本地服务，已有内容已保留。');throw e;}
    finally{clearInterval(clock);clearTimeout(timeout);active=null;el('requestActivity').hidden=true;}
  };
  const ready=api('/api/config').then(apply).catch(e=>setStatus('读取本地配置失败：'+e.message,true));
  window.appSettings={open,close,apply,save:persist,ready,get loaded(){return loaded;}};
})();

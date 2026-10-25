/* 分享链接仅作为参考原稿输入，不生成或伪造 DNA。 */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const statuses = {pending:'待处理',parsing:'解析中',downloading:'下载中',extracting:'提取音频',transcribing:'转文字中',rate_limited:'限流等待',success:'成功',failed:'失败'};
  let serviceConfig = null, refreshing = false, currentJobs = [], editingArticle = null;
  const cards = new Map();

  async function api(path, method='GET', payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(path, {method, headers:{'Content-Type':'application/json','X-Spoken-DNA':'local'},
        ...(payload === undefined ? {} : {body:JSON.stringify(payload)}), signal:controller.signal});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '本地服务请求失败，请重试。');
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('本地服务响应超时；后台任务可能仍在运行，请刷新状态。');
      if (e instanceof TypeError) throw new Error('无法连接本地服务，请先运行项目中的启动脚本。');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // 新凭据永不返回浏览器。保留写作模型原有的网页直连方式和本页会话密钥。
  document.querySelector('label').setAttribute('for','apiKey');
  document.querySelector('label').textContent = '写作模型 API Key';
  el('apiPanel').insertAdjacentHTML('beforeend', `
    <section class="local-config" aria-label="视频转文字配置">
      <div class="card-title" style="font-size:15px;margin-bottom:12px">视频转文字配置</div>
      <div class="local-config-grid">
        <div class="form-group"><label for="asrKey">语音识别 API Key · 硅基流动</label><input id="asrKey" type="password" autocomplete="new-password" placeholder="未配置时粘贴；留空保留已有密钥"><small id="asrSource" class="local-source"></small></div>
        <div class="form-group"><label for="parserToken">起零数据 Token · 分享链接解析</label><input id="parserToken" type="password" autocomplete="new-password" placeholder="留空保留已有配置"><small id="parserSource" class="local-source"></small><small>先把抖音／小红书分享链接解析为视频，再交给语音识别转成文字。使用分享链接导入时需要这项。</small></div>
        <div class="form-group"><label>语音识别模型（固定）</label><div class="fixed-model">SenseVoiceSmall</div><small>系统固定使用 FunAudioLLM/SenseVoiceSmall，无需选择或填写。</small></div>
        <div class="form-group"><label>两项凭据的区别</label><small>起零数据：根据分享链接找到视频。<br>硅基流动：把视频中的音频转成文字。<br>只导入现成文字时，这两项都可以不填。</small></div>
        <div class="form-group"><label for="asrInterval">语音转写最小请求间隔（秒）</label><input id="asrInterval" type="number" min="1" max="120" value="6"><small>语音接口单通道排队。遇到 429 自动等待重试；此间隔是本地保护设置，不代表账号实际额度。</small></div>
      </div>
      <div class="toolbar"><button class="btn btn-primary btn-sm" id="saveLinkConfig">保存转写配置</button><button class="btn btn-outline btn-sm" id="refreshLinkConfig">检查本地配置</button><button class="btn btn-outline btn-sm" id="forgetLinkKeys">清除这两项密钥</button></div>
      <p class="muted-note" id="linkConfigStatus" role="status">正在读取本地配置…</p>
      <small>保存后自动记住，密钥由当前 Windows 用户加密保存在选定的工作目录，不进入项目备份。</small>
    </section>`);
  function displayConfig(c) {
    serviceConfig = c;
    el('asrSource').textContent = (c.asrConfigured ? '已配置 · ' : '') + c.asrSource;
    el('parserSource').textContent = (c.parserConfigured ? '已配置 · ' : '') + c.parserSource;
    el('asrInterval').value = c.asrInterval ?? 6;
    el('linkConfigStatus').textContent = c.warning || (!c.ffmpeg || !c.ffprobe ? '缺少 FFmpeg／FFprobe，请加入 PATH 后重启服务。' : c.asrConfigured && c.parserConfigured ? '本地配置可读取；提交视频后才会验证真实接口与权限。' : '请分别配置语音识别密钥和起零数据 Token。');
  }
  async function refreshConfig() {
    try { displayConfig(await api('/api/config')); }
    catch (e) { el('linkConfigStatus').textContent=e.message; }
  }
  el('refreshLinkConfig').onclick=refreshConfig;
  el('saveLinkConfig').onclick=async()=>{
    const button=el('saveLinkConfig'); button.disabled=true;
    try {
      displayConfig(await api('/api/config','PUT',{asrKey:el('asrKey').value.trim(), parserToken:el('parserToken').value.trim(),remember:true,requireWorkspace:true,asrInterval:Number(el('asrInterval').value)}));
      el('asrKey').value='';el('parserToken').value='';
      showToast(serviceConfig.remember?'转写配置已加密保存在本机':'转写配置已保留至本次服务停止','success');
    } catch(e){showToast(e.message,'error');} finally {button.disabled=false;}
  };
  el('forgetLinkKeys').onclick=async()=>{
    if(!confirm('清除本项目记住的转写密钥，并停止自动复用已有配置？其他项目的配置不会改动。'))return;
    try{displayConfig(await api('/api/config','PUT',{forget:true}));el('asrKey').value='';el('parserToken').value='';showToast('已清除；正在处理的任务使用提交时的配置','success');}catch(e){showToast(e.message,'error');}
  };

  const textPanel=document.createElement('div');textPanel.id='textImportPanel';
  const input=el('batchInput'), hint=input.nextElementSibling, actions=hint.nextElementSibling;
  input.before(textPanel);textPanel.append(input,hint,actions);
  hint.textContent='同一批素材应来自同一位参考作者。多篇原稿用独占一行的 --- 分隔，5 篇不重复原稿可开始分析。';
  const modes=document.createElement('div');modes.className='import-modes';modes.setAttribute('aria-label','素材导入方式');
  modes.innerHTML='<button class="btn btn-outline btn-sm" id="modeText" aria-pressed="true">文本</button><button class="btn btn-outline btn-sm" id="modeLinks" aria-pressed="false">分享链接</button>';
  textPanel.before(modes);
  const linkPanel=document.createElement('div');linkPanel.id='linkImportPanel';linkPanel.hidden=true;
  linkPanel.innerHTML=`<textarea class="article-input-area" id="shareLinksInput" aria-label="批量分享链接" placeholder="粘贴抖音／小红书视频链接，或平台复制的整段分享文案。可混填多条，一批最多 50 条。"></textarea>
    <p class="link-notice">同一批素材应来自同一位参考作者。支持视频转文字；小红书图文／图集暂不支持。转写仅作为参考原稿，查看修改并加入列表后，再沿用原有 DNA 分析与保存流程。</p>
    <div class="toolbar"><button class="btn btn-primary btn-sm" id="startLinkImport">识别链接并转文字</button><button class="btn btn-outline btn-sm" id="refreshLinkJobs">刷新状态</button><button class="btn btn-outline btn-sm" id="clearFinishedLinks">清理已结束记录</button></div>
    <div class="link-summary" id="linkSummary" role="status" aria-live="polite"></div><div class="link-queue" id="linkQueue"></div>`;
  textPanel.after(linkPanel);
  for(const mode of ['Text','Links'])el('mode'+mode).onclick=()=>{
    textPanel.hidden=mode!=='Text';linkPanel.hidden=mode!=='Links';
    el('modeText').setAttribute('aria-pressed',String(mode==='Text'));el('modeLinks').setAttribute('aria-pressed',String(mode==='Links'));
  };
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function inArticles(job){return window.dnaFlow?window.dnaFlow.hasJob(job):state.articles.some(a=>a.sourceJobId===job.id || a.sourceKey===job.key || a.sourceUrl===job.originalUrl);}
  function createEditor(card,job){
    const details=node('details','link-editor'), summary=node('summary','','查看／修改转写原文');details.append(summary);
    const title=node('input');title.setAttribute('aria-label','视频标题');title.value=job.title;
    const area=node('textarea','article-input-area');area.setAttribute('aria-label','转写原文');area.value=job.transcript;
    const original=node('details');original.append(node('summary','','查看未经修改的转写结果'),node('pre','link-original',job.originalTranscript));
    const tools=node('div','toolbar'),save=node('button','btn btn-outline btn-sm','保存修改'),add=node('button','btn btn-primary btn-sm','加入原稿列表');
    details.append(title,area,original,tools);tools.append(save);card.append(details,add);
    const saveEdit=async()=>{if(!area.value.trim())throw new Error('转写原文不能为空。');await api('/api/jobs/'+job.id,'PUT',{title:title.value,transcript:area.value});job.title=title.value.trim()||'未命名视频';job.transcript=area.value.trim();return {title:job.title,transcript:job.transcript};};
    save.onclick=async()=>{save.disabled=true;try{await saveEdit();showToast('标题和原文修改已保存','success');}catch(e){showToast(e.message,'error');}finally{save.disabled=false;}};
    add.onclick=async()=>{
      if(inArticles(job))return showToast('这条视频已在原稿列表中，无需重复加入。','info');
      add.disabled=true;
      try {
        await saveEdit();
        const article={title:job.title,content:job.transcript,sourceUrl:job.originalUrl,platform:job.platform,sourceJobId:job.id,sourceKey:job.key,originalTranscript:job.originalTranscript,authorName:job.authorName||'',authorId:job.authorId||'',importedAt:new Date().toISOString()};
        if(window.dnaFlow){window.dnaFlow.addArticle(article);window.dnaFlow.activateImported();}else state.articles.push(article);
        saveConfig();renderArticleList();add.textContent='已加入原稿列表';showToast('已加入参考原稿；仍需建立表达 DNA 后保存到 DNA 库','success');
      }catch(e){add.disabled=false;showToast(e.message,'error');}
    };
    card._add=add;card._saveEdit=saveEdit;card._editor=true;
  }
  function renderJobs(jobs){
    currentJobs=jobs;
    const ids=new Set(jobs.map(j=>j.id));for(const [id,card]of cards)if(!ids.has(id)){card.remove();cards.delete(id);}
    for(const j of jobs){
      let card=cards.get(j.id);
      if(!card){
        card=node('article','link-job');card.dataset.jobId=j.id;
        const header=node('div','link-job-header'),title=node('strong'),status=node('span','link-status');header.append(title,status);
        const source=node('a','link-source',j.originalUrl);source.href=j.originalUrl;source.target='_blank';source.rel='noopener noreferrer';
        const detail=node('p','link-detail'),retry=node('button','btn btn-outline btn-sm','重试此项');
        retry.onclick=async()=>{retry.disabled=true;try{await api('/api/jobs/'+j.id+'/retry','POST',{});await refreshJobs();}catch(e){showToast(e.message,'error');}finally{retry.disabled=false;}};
        card.append(header,source,detail,retry);card._title=title;card._status=status;card._detail=detail;card._retry=retry;cards.set(j.id,card);el('linkQueue').append(card);
      }
      card.dataset.status=j.status;card._title.textContent=j.platform+' · '+(j.title||'视频分享');card._status.textContent=statuses[j.status]||j.status;
      const active=!['failed','success'].includes(j.status),seconds=Math.max(0,Math.floor(Date.now()/1000-j.createdAt));
      card._detail.textContent=(j.authorName?'作者：'+j.authorName+' · ':j.status==='success'?'作者待确认 · ':'')+j.detail+(active?' · 已等待 '+seconds+' 秒':'')+(j.attempts>1?' · 第 '+j.attempts+' 次处理':'')+(j.cleanupWarning?' · '+j.cleanupWarning:'');
      card._retry.hidden=j.status!=='failed';
      if(j.status==='success'&&!card._editor)createEditor(card,j);
      if(card._add){card._add.disabled=inArticles(j);card._add.textContent=inArticles(j)?'已加入原稿列表':'加入原稿列表';}
    }
    const counts={};for(const j of jobs)counts[j.status]=(counts[j.status]||0)+1;
    el('linkSummary').textContent=jobs.length?Object.entries(counts).map(([s,n])=>(statuses[s]||s)+' '+n+' 条').join(' · '):'尚未提交链接。提交后逐条显示进度，刷新页面可继续查看。';
    window.dnaFlow?.jobsUpdated(jobs);
  }
  async function refreshJobs(){
    if(refreshing)return;refreshing=true;
    try{renderJobs((await api('/api/jobs')).jobs);}catch(e){el('linkSummary').textContent=e.message;}finally{refreshing=false;}
  }
  el('refreshLinkJobs').onclick=refreshJobs;
  el('startLinkImport').onclick=async()=>{
    const btn=el('startLinkImport');btn.disabled=true;
    try{const result=await api('/api/jobs','POST',{text:el('shareLinksInput').value});showToast('新增 '+result.added+' 条，重复跳过 '+result.duplicates+' 条','success');await refreshJobs();}
    catch(e){showToast(e.message,'error');}finally{btn.disabled=false;}
  };
  el('clearFinishedLinks').onclick=async()=>{
    if(!confirm('清理成功／失败的导入记录？已加入原稿列表和 DNA 库的内容会保留。正在处理的任务会保留。'))return;
    try{await api('/api/jobs/clear','POST',{});await refreshJobs();}catch(e){showToast(e.message,'error');}
  };

  // 让加入列表后的原稿仍可回看、编辑，并保留出处；保留原有删除与进度逻辑。
  const renderOld=renderArticleList;
  renderArticleList=function(){
    renderOld();
    el('articleList').querySelectorAll('.article-item').forEach((row,i)=>{
      const a=state.articles[i],btn=node('button','btn btn-outline btn-sm article-edit','查看／编辑');
      btn.onclick=()=>{editingArticle=i;el('singleTitle').value=a.title;el('singleContent').value=a.content;el('addArticleModal').classList.add('open');document.querySelector('#addArticleModal .modal-title').textContent='查看／编辑原稿';};
      row.insertBefore(btn,row.querySelector('.article-item-remove'));
      if(a.sourceUrl){const source=node('a','article-source',(a.platform||'视频')+' · 原始分享链接');source.href=a.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';row.querySelector('.article-item-info').append(source);}
    });
    if(currentJobs.length)renderJobs(currentJobs);
  };
  el('addSingleBtn').addEventListener('click',()=>{editingArticle=null;document.querySelector('#addArticleModal .modal-title').textContent='逐篇添加文章';});
  el('confirmAddBtn').addEventListener('click',e=>{
    if(editingArticle===null)return;
    e.stopImmediatePropagation();const a=state.articles[editingArticle];
    if(!a)return;
    if(!el('singleContent').value.trim())return showToast('原稿不能为空','error');
    a.title=el('singleTitle').value.trim()||'未命名原稿';a.content=el('singleContent').value.trim();
    saveConfig();renderArticleList();el('addArticleModal').classList.remove('open');editingArticle=null;showToast('原稿已更新；有改动时请重新分析 DNA','success');
  },true);

  // 防止导入旧备份中的凭据字段再次进入保存或导出。实际密钥始终与项目资料分离。
  const forbidden=/^(?:api_?key|writing_?key|asr_?key|parser_?token|siliconflow_?api_?key|istero_?api_?token|authorization|credentials?|secrets?|password|token)$/i;
  function cleanBackup(value){
    if(Array.isArray(value))return value.map(cleanBackup);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!forbidden.test(k)).map(([k,v])=>[k,cleanBackup(v)]));
    return value;
  }
  const oldDownload=download;
  download=function(name,data,type){if(name==='口述成稿-项目备份.json')data=JSON.stringify(cleanBackup(JSON.parse(data)),null,2);return oldDownload(name,data,type);};
  for(const key of Object.keys(app))if(forbidden.test(key))delete app[key];
  saveConfig();renderArticleList();refreshConfig();refreshJobs();
  setInterval(()=>{if(!document.hidden)refreshJobs();},1500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshJobs();});
  window.localImport={refreshJobs,cleanBackup,getJobs:()=>structuredClone(currentJobs),
    async addSuccessful(){let added=0;for(const j of currentJobs){if(j.status!=='success'||inArticles(j)||window.dnaFlow?.isArchived(j.id))continue;const card=cards.get(j.id);if(card?._saveEdit)Object.assign(j,await card._saveEdit());const article={title:j.title,content:j.transcript,sourceUrl:j.originalUrl,platform:j.platform,sourceJobId:j.id,sourceKey:j.key,originalTranscript:j.originalTranscript,authorName:j.authorName||'',authorId:j.authorId||'',importedAt:new Date().toISOString()};if(window.dnaFlow)window.dnaFlow.addArticle(article);else state.articles.push(article);added++;}saveConfig();renderArticleList();return added;}
  };
  window.linkConfig={apply:displayConfig,refresh:refreshConfig};
})();

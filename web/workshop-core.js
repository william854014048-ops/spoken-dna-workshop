
// ===== 状态管理 =====
const state = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com/v1',
  apiModel: 'deepseek-chat',
  articles: [],
  strictMode: true,
  distillResults: {
    dna: '', l1: '', l2: '', l35: '', l6: ''
  },
  currentResultTab: 'dna'
};

// ===== 工具函数 =====
function $(id) { return document.getElementById(id); }

function showToast(msg, type) {
  type = type || 'info';
  var container = $('toastContainer');
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(function() { toast.remove(); }, 300);
  }, 3000);
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function countWords(text) {
  if (!text) return 0;
  return text.replace(/\s/g, '').length;
}

// ===== localStorage 持久化 =====
function loadConfig() {
  try {
    var saved = localStorage.getItem('writing-dna-workshop-v2');
    if (saved) {
      var data = JSON.parse(saved);
      // 只有 localStorage 里有非空值才覆盖预设配置
      if (data.apiKey) state.apiKey = data.apiKey;
      if (data.apiBase) state.apiBase = data.apiBase;
      if (data.apiModel) state.apiModel = data.apiModel;
      state.articles = data.articles || [];
      state.strictMode = data.strictMode !== false;
    }
  } catch(e) {}
}

function saveConfig() {
  try {
    localStorage.setItem('writing-dna-workshop-v2', JSON.stringify({
      apiKey: state.apiKey,
      apiBase: state.apiBase,
      apiModel: state.apiModel,
      articles: state.articles,
      strictMode: state.strictMode
    }));
  } catch(e) {}
}

// ===== API 配置 =====
function updateApiStatus() {
  var statusEl = $('apiStatus');
  var textEl = $('apiStatusText');
  if (state.apiKey) {
    statusEl.classList.add('configured');
    textEl.textContent = 'API 已配置';
  } else {
    statusEl.classList.remove('configured');
    textEl.textContent = '未配置 API';
  }
}

function initApiPanel() {
  $('apiKey').value = state.apiKey;
  $('apiBase').value = state.apiBase;
  // 设置模型下拉框
  var knownModels = ['deepseek-chat','deepseek-v4-pro','deepseek-v4-flash'];
  if (knownModels.indexOf(state.apiModel) >= 0) {
    $('apiModel').value = state.apiModel;
    $('apiModelCustom').style.display = 'none';
  } else {
    $('apiModel').value = 'custom';
    $('apiModelCustom').style.display = 'block';
    $('apiModelCustom').value = state.apiModel;
  }
}

// 模型下拉切换
$('apiModel').addEventListener('change', function() {
  if (this.value === 'custom') {
    $('apiModelCustom').style.display = 'block';
  } else {
    $('apiModelCustom').style.display = 'none';
  }
});

function getCurrentModel() {
  var sel = $('apiModel').value;
  if (sel === 'custom') {
    return $('apiModelCustom').value.trim();
  }
  return sel;
}

// 把输入框里的配置同步进 state。
// 测试连接成功、点击保存、以及开始蒸馏/写作/清理前都会调用，
// 避免"测试成功但没点保存，state 里还是空"导致误判未配置。
function syncApiFromInputs() {
  var key = $('apiKey').value.trim();
  var base = $('apiBase').value.trim();
  var model = getCurrentModel() || 'deepseek-chat';
  var changed = key !== state.apiKey || base !== state.apiBase || model !== state.apiModel;
  state.apiKey = key;
  if (base) state.apiBase = base;
  state.apiModel = model;
  if (changed) {
    saveConfig();
    updateApiStatus();
  }
}

$('toggleApiPanel').addEventListener('click', function() {
  $('apiPanel').classList.toggle('open');
});

$('saveApiBtn').addEventListener('click', function() {
  syncApiFromInputs();
  updateDistillButton();
  updateWriteButton();
  showToast('API 配置已保存', 'success');
});

$('testApiBtn').addEventListener('click', async function() {
  var key = $('apiKey').value.trim();
  var base = $('apiBase').value.trim();
  var model = getCurrentModel() || 'deepseek-chat';
  if (!key) { showToast('请先填写 API Key', 'error'); return; }
  var btn = $('testApiBtn');
  btn.textContent = '测试中...';
  btn.disabled = true;
  try {
    var url = (base || 'https://api.deepseek.com/v1') + '/chat/completions';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      })
    });
    if (res.ok) {
      syncApiFromInputs();
      updateDistillButton();
      updateWriteButton();
      showToast('连接成功！模型：' + model + '（已自动保存配置）', 'success');
    } else {
      showToast('连接失败：HTTP ' + res.status + '，请检查写作模型密钥和接口配置。', 'error');
    }
  } catch(e) {
    if (e.name === 'TypeError' || (e.message && e.message.indexOf('Failed to fetch') >= 0)) {
      showToast('网络错误：连不上服务器，请检查"API Base URL"是否填对（' + e.message + '）', 'error');
    } else {
      showToast('网络错误：' + e.message, 'error');
    }
  }
  btn.textContent = '测试连接';
  btn.disabled = false;
});

// ===== Tab 切换 =====
document.querySelectorAll('.tab-item').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab-item').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ===== 文章管理 =====
function renderArticleList() {
  var list = $('articleList');
  if (state.articles.length === 0) {
    list.innerHTML = '<div class="article-list-empty">尚未添加文章</div>';
  } else {
    list.innerHTML = state.articles.map(function(a, i) {
      return '<div class="article-item">' +
        '<div class="article-item-info">' +
          '<div class="article-item-title">' + escapeHtml(a.title) + '</div>' +
          '<div class="article-item-meta">#' + (i+1) + ' · ' + countWords(a.content) + ' 字</div>' +
        '</div>' +
        '<button class="article-item-remove" data-index="' + i + '" title="删除">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
        '</button>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.article-item-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.dataset.index);
        state.articles.splice(idx, 1);
        saveConfig();
        renderArticleList();
        updateArticleProgress();
      });
    });
  }
  updateArticleProgress();
  updateDistillButton();
}

function updateArticleProgress() {
  var count = state.articles.length;
  var pct = Math.min(100, (count / 20) * 100);
  $('articleProgress').style.width = pct + '%';
  $('articleCountText').textContent = count + ' 篇文章';
}

function updateDistillButton() {
  syncApiFromInputs();
  var btn = $('startDistillBtn');
  var hint = $('distillHint');
  if (state.articles.length >= 5 && state.apiKey) {
    btn.disabled = false;
    hint.style.display = 'none';
  } else {
    btn.disabled = true;
    if (!state.apiKey) {
      hint.textContent = '请先配置 API';
      hint.style.color = 'var(--danger)';
    } else {
      hint.textContent = '至少添加 5 篇文章（当前 ' + state.articles.length + ' 篇）';
      hint.style.color = 'var(--text-muted)';
    }
    hint.style.display = 'inline';
  }
}

// 批量导入
$('importBatchBtn').addEventListener('click', function() {
  var text = $('batchInput').value.trim();
  if (!text) { showToast('请先粘贴文章内容', 'error'); return; }
  var parts = text.split(/^---\s*$/m).map(function(p) { return p.trim(); }).filter(Boolean);
  var added = 0;
  parts.forEach(function(part) {
    var lines = part.split('\n');
    var title = lines[0].replace(/^#+\s*/, '').trim().substring(0, 60) || '未命名文章';
    var content = part;
    state.articles.push({ title: title, content: content });
    added++;
  });
  $('batchInput').value = '';
  saveConfig();
  renderArticleList();
  showToast('已导入 ' + added + ' 篇文章', 'success');
});

// 逐篇添加
$('addSingleBtn').addEventListener('click', function() {
  $('singleTitle').value = '';
  $('singleContent').value = '';
  $('addArticleModal').classList.add('open');
});

$('cancelAddBtn').addEventListener('click', function() {
  $('addArticleModal').classList.remove('open');
});

$('confirmAddBtn').addEventListener('click', function() {
  var title = $('singleTitle').value.trim() || '未命名文章';
  var content = $('singleContent').value.trim();
  if (!content) { showToast('请输入文章正文', 'error'); return; }
  state.articles.push({ title: title, content: content });
  saveConfig();
  renderArticleList();
  $('addArticleModal').classList.remove('open');
  showToast('已添加文章', 'success');
});

$('clearArticlesBtn').addEventListener('click', function() {
  if (state.articles.length === 0) return;
  if (confirm('确定清空全部 ' + state.articles.length + ' 篇文章吗？')) {
    state.articles = [];
    saveConfig();
    renderArticleList();
    showToast('已清空', 'info');
  }
});

// ===== 蒸馏功能 =====
var DISTILL_STEPS = [
  { key: 'l1', name: 'L1 表层语言分析', pct: 15 },
  { key: 'l2', name: 'L2 文章结构分析', pct: 30 },
  { key: 'l35', name: 'L3-L5 选题与认知框架', pct: 55 },
  { key: 'l6', name: 'L6 视觉风格分析', pct: 75 },
  { key: 'dna', name: '整合 Writing-DNA.md', pct: 100 }
];

function buildDistillPrompt(stepKey) {
  var authorName = $('authorName').value.trim() || '该作者';
  var lang = $('outputLang').value;
  var langNote = lang === 'zh' ? '请用中文输出。' : lang === 'en' ? 'Please output in English.' : '请根据语料主要语言输出。';
  var articlesText = state.articles.map(function(a, i) {
    return '=== 文章 ' + (i+1) + ': ' + a.title + ' ===\n' + a.content;
  }).join('\n\n');

  var prompts = {
    l1: '你是一位写作风格分析师。请对以下' + state.articles.length + '篇文章进行 L1 表层语言分析，输出结构化报告：\n\n' +
        '1. 词频分析：高频名词（前30）、高频动词（前20）、需要注意的过度使用副词\n' +
        '2. 句式分析：平均句长估算、短句占比、长句占比、段落平均句数\n' +
        '3. 标点与格式：破折号vs括号使用倾向、引号使用场景、小标题风格、中英文混用模式\n' +
        '4. 语言规律总结：该作者最显著的3-5条语言特征\n\n' +
        langNote + '\n\n' + articlesText,

    l2: '你是一位写作结构分析师。请对以下' + state.articles.length + '篇文章进行 L2 文章结构分析，输出结构化报告：\n\n' +
        '1. 开头 hook 类型统计与典型示例（问题式/场景式/数据式/观点式/悬念式）\n' +
        '2. 正文架构模式（总-分/对比/时间线/Q&A/其他），每种模式的典型结构骨架\n' +
        '3. 结尾处理方式统计（收束/悬念/呼吁/自然结束）\n' +
        '4. 按内容类型整理可复用的结构模板（至少2种类型）\n\n' +
        langNote + '\n\n' + articlesText,

    l35: '你是一位写作认知分析师。请对以下' + state.articles.length + '篇文章进行 L3-L5 深度分析，输出结构化报告：\n\n' +
        '【L3 选题逻辑】\n' +
        '- 切入时机倾向（早期判断/跟进分析/事后复盘）\n' +
        '- 切入角度偏好（当事人视角/读者视角/系统视角）\n' +
        '- 什么类型的话题他们倾向于不写\n\n' +
        '【L4 素材策略】\n' +
        '- 主要依赖哪类素材（一手观察/二手整理/数据引用）\n' +
        '- 权威对象选取标准\n' +
        '- 如何处理敏感或争议性信息\n' +
        '- 图片/截图在论证中承担的角色\n\n' +
        '【L5 认知框架】\n' +
        '- 对主题的核心假设是什么\n' +
        '- 反复出现的核心命题（3-5条，非显而易见的）\n' +
        '- 他们认为什么是"好对象""好作品"\n\n' +
        langNote + '\n\n' + articlesText,

    l6: '你是一位视觉排版分析师。请对以下' + state.articles.length + '篇文章进行 L6 视觉风格分析，输出结构化报告：\n\n' +
        '1. 配图策略：图文比估算、图片类型分布（截图/图表/人物照/示意图/meme）、首图风格、图片功能分类（证据型/演示型/数据型/叙事型/情绪型）、图文协作模式\n' +
        '2. 排版格式：字号层级倾向、加粗使用频率与用途、段落长度与节奏、分隔方式（小标题/分隔线/空行/加粗句）\n' +
        '3. 色彩与强调：是否使用彩色文字、背景色块使用、整体色调倾向\n\n' +
        langNote + '\n\n' + articlesText,

    dna: '你是一位写作风格整合专家。以下是对' + authorName + '的六层分析结果。请将它们整合为一份完整的 Writing-DNA.md 文档，用于指导 AI 复刻该作者的写作风格。\n\n' +
        '文档结构：\n' +
        '# ' + authorName + ' 写作 DNA\n\n' +
        '## 一、语言特征（L1）\n' +
        '## 二、结构模板（L2，按类型分类）\n' +
        '## 三、选题判断标准（L3）\n' +
        '## 四、素材使用规范（L4）\n' +
        '## 五、核心认知框架（L5）\n' +
        '## 六、视觉风格指南（L6）\n\n' +
        '要求：\n' +
        '- 每份内容都是可操作的规则，不是空泛描述\n' +
        '- 给没读过该作者的人，读完能写出70分近似风格的文章\n' +
        '- 总字数控制在4000字以内\n' +
        langNote + '\n\n' +
        '===== L1 语言分析 =====\n' + (state.distillResults.l1 || '') + '\n\n' +
        '===== L2 结构分析 =====\n' + (state.distillResults.l2 || '') + '\n\n' +
        '===== L3-L5 认知分析 =====\n' + (state.distillResults.l35 || '') + '\n\n' +
        '===== L6 视觉分析 =====\n' + (state.distillResults.l6 || '')
  };

  return prompts[stepKey];
}

async function callAPI(messages, maxTokens) {
  maxTokens = maxTokens || 4000;
  var base = state.apiBase || 'https://api.deepseek.com/v1';
  var url = base + '/chat/completions';
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 300000); // 5分钟超时
  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.apiKey
      },
      body: JSON.stringify({
        model: state.apiModel,
        messages: messages,
        temperature: 0.3,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      var errText = await res.text();
      if (res.status === 401) {
        throw new Error('API Key 无效（401）：请检查密钥是否复制完整、是否属于所填接口地址的平台');
      }
      throw new Error('API 错误 ' + res.status + ': ' + errText.substring(0, 200));
    }
    var data = await res.json();
    return data.choices[0].message.content;
  } catch(e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('请求超时（超过5分钟），请检查网络或重试');
    }
    if (e.name === 'TypeError' || (e.message && e.message.indexOf('Failed to fetch') >= 0)) {
      throw new Error('连不上服务器：请检查"API Base URL"是否填对、网络是否正常');
    }
    throw e;
  }
}

$('startDistillBtn').addEventListener('click', async function() {
  syncApiFromInputs();
  if (state.articles.length < 5) { showToast('至少需要 5 篇文章', 'error'); return; }
  if (!state.apiKey) { showToast('请先配置 API', 'error'); return; }

  var btn = $('startDistillBtn');
  btn.disabled = true;
  btn.textContent = '蒸馏中...';
  $('distillProgressCard').style.display = 'block';
  $('resultCard').style.display = 'none';

  // 重置结果
  state.distillResults = { dna: '', l1: '', l2: '', l35: '', l6: '' };

  try {
    for (var i = 0; i < DISTILL_STEPS.length; i++) {
      var step = DISTILL_STEPS[i];
      $('distillProgressBar').style.width = step.pct + '%';
      $('distillStepText').innerHTML = '<span class="spinner"></span><span>正在进行：' + step.name + '</span>';

      var prompt = buildDistillPrompt(step.key);
      var result = await callAPI([
        { role: 'system', content: '你是一位专业的写作风格分析师，擅长从语料中提炼可复用的写作规律。输出结构化、可操作的分析报告。' },
        { role: 'user', content: prompt }
      ]);
      state.distillResults[step.key] = result;
    }

    $('distillStepText').innerHTML = '<span style="color:var(--success);">✓ 蒸馏完成！</span>';
    showToast('蒸馏完成！', 'success');
    renderResults();
    $('resultCard').style.display = 'block';
  } catch(e) {
    $('distillStepText').innerHTML = '<span style="color:var(--danger);">✗ 出错：' + escapeHtml(e.message) + '</span>';
    showToast('蒸馏失败：' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '开始蒸馏';
});

function renderResults() {
  $('resultText-dna').textContent = state.distillResults.dna || '';
  $('resultText-l1').textContent = state.distillResults.l1 || '';
  $('resultText-l2').textContent = state.distillResults.l2 || '';
  $('resultText-l35').textContent = state.distillResults.l35 || '';
  $('resultText-l6').textContent = state.distillResults.l6 || '';
}

// 结果 Tab 切换
document.querySelectorAll('.result-tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.result-tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.result-content').forEach(function(c) { c.classList.remove('active'); });
    tab.classList.add('active');
    $('result-' + tab.dataset.result).classList.add('active');
    state.currentResultTab = tab.dataset.result;
  });
});

// 复制当前结果
$('copyResultBtn').addEventListener('click', function() {
  var text = state.distillResults[state.currentResultTab] || '';
  if (!text) { showToast('暂无内容', 'error'); return; }
  navigator.clipboard.writeText(text).then(function() {
    showToast('已复制到剪贴板', 'success');
  }).catch(function() {
    showToast('复制失败', 'error');
  });
});

// 导出全部
$('exportAllBtn').addEventListener('click', function() {
  var authorName = $('authorName').value.trim() || 'writing-dna';
  var content = '# ' + authorName + ' 写作 DNA 完整产物\n\n' +
    '本文件由写作 DNA 工坊生成，包含六层分析及最终整合文档。\n\n' +
    '---\n\n' +
    '## Writing-DNA.md（最终整合）\n\n' + (state.distillResults.dna || '暂无') + '\n\n' +
    '---\n\n' +
    '## L1 语言 DNA\n\n' + (state.distillResults.l1 || '暂无') + '\n\n' +
    '---\n\n' +
    '## L2 文章结构模板\n\n' + (state.distillResults.l2 || '暂无') + '\n\n' +
    '---\n\n' +
    '## L3-L5 写作视角与认知框架\n\n' + (state.distillResults.l35 || '暂无') + '\n\n' +
    '---\n\n' +
    '## L6 视觉风格指南\n\n' + (state.distillResults.l6 || '暂无');

  var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = authorName + '-writing-dna.md';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 .md 文件', 'success');
});

// ===== 去 AI 味 =====
var DEAI_RULES = [
  { num: '01', name: '翻案腔' },
  { num: '02', name: '顿号罗列过密' },
  { num: '03', name: '相邻句结构同款' },
  { num: '04', name: '破折号滥用' },
  { num: '05', name: '提示性冒号' },
  { num: '06', name: '序数词当小标题' },
  { num: '07', name: '拟人化喻体' },
  { num: '08', name: '具体数据被概括覆盖' },
  { num: '09', name: '禁用起手式' },
  { num: '10', name: '翻译腔' },
  { num: '11', name: '段首零主语评论' }
];

function buildDeaiSystemPrompt() {
  var strict = state.strictMode;
  return '你是文字编辑，去除文本中的AI写作痕迹。\n\n' +
    '【原则】白名单改写，只处理下面11条规则，未命中逐字保留；信息守恒，不增不删；不改框架；最小改动。' +
    (strict ? '严格模式：只改明确命中部分。\n' : '非严格模式：可更主动调整。\n') +
    '\n【11条规则】\n' +
    '1.翻案腔："不是…而是""你以为…其实""说到底"等先立误解再推翻，改为直接判断。\n' +
    '2.顿号过密：一个分句内两个以上顿号连三项并列，能概括就概括。\n' +
    '3.相邻句同款：相邻两句逗号数、成分顺序、长度接近像填表，打散其中一句。\n' +
    '4.破折号滥用：破折号制造停顿揭晓或插入不必要补充，改为完整句或逗号。\n' +
    '5.提示性冒号："一句话总结：""核心是：""关键在于："等提示语，删掉直接写。\n' +
    '6.序数词小标题：小标题以"一、二、三"或"第一、第二"编号且连续三个以上，删编号留文字。\n' +
    '7.拟人化喻体："像一位智慧的导师"等理想化职业人格+褒义修饰，改为实际功能描述。\n' +
    '8.概括覆盖数据：用"显著提升""大幅增长"但同段已有具体数值，把具体值提上来。\n' +
    '9.禁用起手式："说白了""说穿了""先说结论"，删掉直接给判断。\n' +
    '10.翻译腔(五种)：过长前置定语→拆句；"当…时"→删当和时；"对于…来说"→对象放主语位；句首"然而/因此/此外"→移主语后或换"不过/其实"；"这意味着/这表明"复述句→并入前句。\n' +
    '11.段首零主语：非首段以评论语开头且无"这/那/其/此"回指，补回指词或点明对象。\n\n' +
    '【不改】句长段落参差、单字虚词少、被动句名词化长句、"首先…其次"、问句设问、比喻本身、对话体口语体文学性、学术新闻公文、引用原文代码外语、小红书特色(emoji/#话题#/@用户/语气词/流行语/空行节奏)、种草测评具体信息。\n\n' +
    '【输出】先输出改写全文，空一行，输出JSON：[{"rule":"规则名","count":次数}]，按次数降序，只统计确实改动的。';
}

$('deaiInput').addEventListener('input', function() {
  syncApiFromInputs();
  var text = $('deaiInput').value;
  $('deaiWordCount').textContent = countWords(text) + ' 字';
  $('startDeaiBtn').disabled = !text.trim() || !state.apiKey;
  if (!state.apiKey && text.trim()) {
    $('startDeaiBtn').disabled = true;
  }
});

$('clearDeaiInputBtn').addEventListener('click', function() {
  $('deaiInput').value = '';
  $('deaiWordCount').textContent = '0 字';
  $('startDeaiBtn').disabled = true;
});

// 严格模式切换
$('strictToggleWrap').addEventListener('click', function() {
  state.strictMode = !state.strictMode;
  $('strictToggle').classList.toggle('on', state.strictMode);
  saveConfig();
});

$('startDeaiBtn').addEventListener('click', async function() {
  syncApiFromInputs();
  var text = $('deaiInput').value.trim();
  if (!text) { showToast('请输入原文', 'error'); return; }
  if (!state.apiKey) { showToast('请先配置 API', 'error'); return; }

  var btn = $('startDeaiBtn');
  btn.disabled = true;
  btn.textContent = '清理中...';
  $('deaiOutput').classList.remove('empty');
  $('deaiOutput').textContent = '正在分析并改写，请稍候...';
  $('deaiStatsPanel').style.display = 'none';
  $('copyDeaiBtn').disabled = true;

  try {
    var inputLen = countWords(text);
    var maxTokens = Math.min(2000, Math.max(800, inputLen * 3 + 300));
    var result = await callAPI([
      { role: 'system', content: buildDeaiSystemPrompt() },
      { role: 'user', content: text }
    ], maxTokens);

    // 分离改写文本和 JSON 统计
    var jsonMatch = result.match(/\[[\s\S]*\{"rule"[\s\S]*\][\s\S]*$/);
    var cleanText = result;
    var stats = [];
    if (jsonMatch) {
      cleanText = result.substring(0, jsonMatch.index).trim();
      try {
        var jsonStr = jsonMatch[0].trim();
        // 取最后一个完整的 JSON 数组
        var lastBracket = jsonStr.lastIndexOf(']');
        if (lastBracket > -1) {
          jsonStr = jsonStr.substring(0, lastBracket + 1);
          stats = JSON.parse(jsonStr);
        }
      } catch(e) { stats = []; }
    }

    $('deaiOutput').textContent = cleanText;
    $('copyDeaiBtn').disabled = false;

    if (stats.length > 0) {
      $('deaiStatsPanel').style.display = 'block';
      $('deaiStatsGrid').innerHTML = stats.map(function(s) {
        return '<div class="stat-item">' +
          '<span class="stat-item-name">' + escapeHtml(s.rule || s.name || '') + '</span>' +
          '<span class="stat-item-count">' + (s.count || 0) + ' 处</span>' +
        '</div>';
      }).join('');
    }

    showToast('清理完成！', 'success');
  } catch(e) {
    $('deaiOutput').textContent = '出错：' + e.message;
    $('deaiOutput').classList.add('empty');
    showToast('清理失败：' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '开始清理';
});

$('copyDeaiBtn').addEventListener('click', function() {
  var text = $('deaiOutput').textContent;
  if (!text || text === '清理结果将显示在这里') { showToast('暂无内容', 'error'); return; }
  navigator.clipboard.writeText(text).then(function() {
    showToast('已复制到剪贴板', 'success');
  }).catch(function() {
    showToast('复制失败', 'error');
  });
});

// 规则说明折叠
$('rulesToggle').addEventListener('click', function() {
  $('rulesPanel').classList.toggle('open');
  var arrow = $('rulesArrow');
  if ($('rulesPanel').classList.contains('open')) {
    arrow.style.transform = 'rotate(90deg)';
  } else {
    arrow.style.transform = 'rotate(0deg)';
  }
  arrow.style.transition = 'transform 0.2s';
});

// ===== 按 DNA 写作 =====
function updateWriteButton() {
  syncApiFromInputs();
  var dna = $('dnaInput').value.trim();
  var topic = $('writeTopic').value.trim();
  var btn = $('startWriteBtn');
  var hint = $('writeHint');
  if (dna && topic && state.apiKey) {
    btn.disabled = false;
    hint.style.display = 'none';
  } else {
    btn.disabled = true;
    if (!state.apiKey) {
      hint.textContent = '请先配置 API';
      hint.style.color = 'var(--danger)';
    } else if (!dna) {
      hint.textContent = '请先加载或粘贴写作 DNA';
      hint.style.color = 'var(--text-muted)';
    } else {
      hint.textContent = '请填写文章主题';
      hint.style.color = 'var(--text-muted)';
    }
    hint.style.display = 'inline';
  }
}

$('loadCurrentDnaBtn').addEventListener('click', function() {
  var dna = state.distillResults.dna;
  var l1 = state.distillResults.l1;
  var l2 = state.distillResults.l2;
  var l35 = state.distillResults.l35;
  var l6 = state.distillResults.l6;
  if (!dna && !l1 && !l2 && !l35 && !l6) {
    showToast('当前没有蒸馏结果，请先在蒸馏 Tab 完成蒸馏', 'error');
    return;
  }
  var fullDna = '# 完整写作 DNA\n\n' +
    (dna ? '## Writing-DNA.md（整合版）\n\n' + dna + '\n\n' : '') +
    (l1 ? '## L1 语言 DNA\n\n' + l1 + '\n\n' : '') +
    (l2 ? '## L2 文章结构\n\n' + l2 + '\n\n' : '') +
    (l35 ? '## L3-L5 认知框架\n\n' + l35 + '\n\n' : '') +
    (l6 ? '## L6 视觉风格\n\n' + l6 : '');
  $('dnaInput').value = fullDna.trim();
  $('dnaLoadedHint').style.display = 'block';
  updateWriteButton();
  showToast('已加载当前蒸馏结果', 'success');
});

$('clearDnaBtn').addEventListener('click', function() {
  $('dnaInput').value = '';
  $('dnaLoadedHint').style.display = 'none';
  updateWriteButton();
});

$('dnaInput').addEventListener('input', function() {
  if ($('dnaInput').value.trim()) {
    $('dnaLoadedHint').style.display = 'block';
  } else {
    $('dnaLoadedHint').style.display = 'none';
  }
  updateWriteButton();
});

$('writeTopic').addEventListener('input', updateWriteButton);

function buildWritePrompt() {
  var dna = $('dnaInput').value.trim();
  var topic = $('writeTopic').value.trim();
  var type = $('writeType').value;
  var length = $('writeLength').value;
  var platform = $('writePlatform').value.trim();
  var extra = $('writeExtra').value.trim();

  var prompt = '你是一位专业写作者。请严格按照下面提供的「写作 DNA」风格，写一篇全新的文章。\n\n' +
    '【写作需求】\n' +
    '- 主题：' + topic + '\n' +
    '- 内容类型：' + type + '\n' +
    '- 目标字数：约 ' + length + ' 字\n' +
    (platform ? '- 发布平台：' + platform + '\n' : '') +
    (extra ? '- 补充要求：' + extra + '\n' : '') +
    '\n【写作优先级】\n' +
    '1. 本次写作需求（主题、类型、字数、平台）\n' +
    '2. DNA 中的文章结构模板（匹配当前类型的那套）\n' +
    '3. DNA 中的语言特征与视觉风格（句长、标点、加粗、段落节奏）\n' +
    '4. DNA 中的认知框架（决定观点立场和素材选择，不决定句式）\n\n' +
    '【重要规则】\n' +
    '- 复刻的是写法（语言风格、结构、视角），不是原文内容\n' +
    '- 原文里的具体观点、事实、案例不能直接搬进新文章\n' +
    '- 可以参考 DNA 中描述的选题逻辑和素材偏好，但内容必须是全新的\n' +
    '- 严格遵守 DNA 中的语言习惯（句长分布、标点使用、用词偏好）\n' +
    '- 按 DNA 中的结构模板组织文章（开头 hook、正文架构、结尾方式）\n' +
    '- 输出完整的文章正文，不需要额外说明\n\n' +
    '【写作 DNA】\n' + dna;

  return prompt;
}

$('startWriteBtn').addEventListener('click', async function() {
  syncApiFromInputs();
  var dna = $('dnaInput').value.trim();
  var topic = $('writeTopic').value.trim();
  if (!dna) { showToast('请先加载或粘贴写作 DNA', 'error'); return; }
  if (!topic) { showToast('请填写文章主题', 'error'); return; }
  if (!state.apiKey) { showToast('请先配置 API', 'error'); return; }

  var btn = $('startWriteBtn');
  btn.disabled = true;
  btn.textContent = '写作中...';
  $('writeProgressCard').style.display = 'block';
  $('writeResultCard').style.display = 'none';

  try {
    var prompt = buildWritePrompt();
    var result = await callAPI([
      { role: 'system', content: '你是一位专业写作者，擅长模仿指定的写作风格产出全新文章。严格遵守提供的写作 DNA，输出完整文章正文。' },
      { role: 'user', content: prompt }
    ]);

    $('writeResultText').textContent = result;
    $('writeResultCard').style.display = 'block';
    $('writeProgressCard').style.display = 'none';
    showToast('写作完成！', 'success');
  } catch(e) {
    $('writeStepText').innerHTML = '<span style="color:var(--danger);">出错：' + escapeHtml(e.message) + '</span>';
    showToast('写作失败：' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '开始写作';
});

$('copyWriteBtn').addEventListener('click', function() {
  var text = $('writeResultText').textContent;
  if (!text) { showToast('暂无内容', 'error'); return; }
  navigator.clipboard.writeText(text).then(function() {
    showToast('已复制到剪贴板', 'success');
  }).catch(function() {
    showToast('复制失败', 'error');
  });
});

$('exportWriteBtn').addEventListener('click', function() {
  var text = $('writeResultText').textContent;
  var topic = $('writeTopic').value.trim() || 'article';
  if (!text) { showToast('暂无内容', 'error'); return; }
  var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = topic.substring(0, 30) + '.md';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 .md 文件', 'success');
});

// ===== 初始化 =====
loadConfig();
initApiPanel();
updateApiStatus();
renderArticleList();
$('strictToggle').classList.toggle('on', state.strictMode);
updateWriteButton();

// 点击模态框外部关闭
$('addArticleModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

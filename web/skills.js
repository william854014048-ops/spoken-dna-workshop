/* AI 任务提示词来自项目 skills/ 目录；没有内嵌的备用规则。 */
(() => {
  'use strict';
  let bundle=null;
  async function load(){
    if(!bundle)bundle=fetch('/api/skills',{cache:'no-store'}).then(async res=>{const data=await res.json();if(!res.ok)throw new Error(data.error||'无法读取项目 Skill。');return data.skills;}).catch(e=>{bundle=null;throw e;});
    return bundle;
  }
  window.projectSkills={async text(name,part,values={}){
    const skills=await load(),template=skills[name]?.[part];
    if(typeof template!=='string')throw new Error('项目 Skill 缺少 '+name+'/'+part+'.md，请检查工程文件。');
    return template.replace(/\{\{(\w+)\}\}/g,(_,key)=>Object.hasOwn(values,key)?String(values[key]):'');
  }};
})();

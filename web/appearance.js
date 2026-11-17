/* Device appearance preference, shared by all windows on this origin. */
(() => {
  const themes = [['blue','冷白蓝','#ffffff','#f5f6f8','#20232b','#626b79','#e3e6ec','#3659d9','#edf1ff','#f4f5f8'],['neutral','素白','#fcfcfb','#f2f2f0','#353a40','#676d73','#e0e2e3','#59636b','#e5e7e7','#ededeb'],['rose','浅玫瑰','#fffafb','#f7eef1','#45363d','#78636e','#ebdce2','#985574','#f4e3eb','#fcf4f7'],['dark','深石墨','#181b22','#12151b','#eef0f5','#aeb6c4','#353b48','#a8bcff','#2b3553','#222731'],['nord','北境蓝','#2e3440','#272d37','#eceff4','#b9c6d6','#465163','#98bed8','#40526a','#353e4c'],['forest','深松绿','#252e2b','#1e2724','#e4ede7','#b1c3b8','#41564b','#9bc8ae','#354e41','#2c3832'],['mist','雾白','#ffffff','#f5f6f7','#343a40','#666d75','#e2e5e8','#343a40','#eceef0','#f0f1f3']];
  const key = 'memokeep-appearance-v1';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const dark = id => ['dark','nord','forest'].includes(id);
  const defaults = () => ({mode:'system',light:'blue',dark:'dark'});
  function read() {
    try { const value=JSON.parse(localStorage.getItem(key)); return {
      mode:['system','light','dark'].includes(value?.mode)?value.mode:'system',
      light:themes.some(t=>t[0]===value?.light&&!dark(t[0]))?value.light:'blue',
      dark:themes.some(t=>t[0]===value?.dark&&dark(t[0]))?value.dark:'dark'
    }; } catch { return defaults(); }
  }
  let preference=read();
  function apply(save=false) {
    const isDark=preference.mode==='system'?system.matches:preference.mode==='dark';
    const id=preference[isDark?'dark':'light'], theme=themes.find(t=>t[0]===id);
    const html=document.documentElement;
    html.dataset.theme=id; html.dataset.appearance=isDark?'dark':'light';
    html.style.colorScheme=isDark?'dark':'light';
    ['canvas','sidebar','ink','muted','line','blue','selected','hover'].forEach((k,i)=>html.style.setProperty('--'+k,theme[i+2]));
    html.style.setProperty('--blue-soft',theme[8]);
    html.style.setProperty('--mk-ink',theme[4]); html.style.setProperty('--mk-muted',theme[5]);
    let saved=true;
    if(save) try { localStorage.setItem(key,JSON.stringify(preference)); } catch { saved=false; }
    document.querySelectorAll('[data-appearance-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.appearanceMode===preference.mode)));
    // 浅色、深色各有一个选中项；当前正在用的那一组标出来。
    document.querySelectorAll('[data-appearance-theme]').forEach(b=>{const group=dark(b.dataset.appearanceTheme)?'dark':'light';const selected=preference[group]===b.dataset.appearanceTheme;b.setAttribute('aria-checked',String(selected));b.classList.toggle('is-in-use',b.dataset.appearanceTheme===id);b.tabIndex=selected?0:-1;});
    document.querySelectorAll('[data-appearance-group]').forEach(g=>g.classList.toggle('is-current',g.dataset.appearanceGroup===(isDark?'dark':'light')));
    const status=document.getElementById('appearanceStatus');
    if(status) status.textContent=saved?'当前主题：'+theme[1]+(preference.mode==='system'?' · 跟随系统':''):'已应用主题，但无法保存设置';
  }
  apply(); // Before first paint, including detached note windows.
  system.addEventListener('change',()=>{if(preference.mode==='system')apply();});
  window.addEventListener('storage',e=>{if(e.key===key||e.key===null){preference=read();apply();}});
  document.addEventListener('DOMContentLoaded',()=>{
    const grid=document.getElementById('appearanceThemes');
    if(!grid)return;
    const option=t=>`<button type="button" class="appearance-theme" role="radio" data-appearance-theme="${t[0]}" aria-label="${t[1]}"><span class="appearance-swatches" aria-hidden="true">${[t[3],t[2],t[8],t[7]].map(c=>`<i style="background:${c}"></i>`).join('')}</span><span>${t[1]}</span><span class="appearance-check" aria-hidden="true">✓</span></button>`;
    grid.removeAttribute('role'); grid.removeAttribute('aria-label');
    grid.innerHTML=[['light','浅色时用'],['dark','深色时用']].map(([group,label])=>`<div class="appearance-group" data-appearance-group="${group}"><h4 id="appearanceGroup-${group}">${label}<small>正在使用</small></h4><div class="appearance-group-options" role="radiogroup" aria-labelledby="appearanceGroup-${group}">${themes.filter(t=>dark(t[0])===(group==='dark')).map(option).join('')}</div></div>`).join('');
    const choose=id=>{const mode=dark(id)?'dark':'light';preference.mode=mode;preference[mode]=id;apply(true);};
    grid.addEventListener('click',e=>{const b=e.target.closest('[data-appearance-theme]');if(b)choose(b.dataset.appearanceTheme);});
    grid.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault(); const buttons=[...(document.activeElement?.closest?.('[role=radiogroup]')||grid).querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      const count=buttons.length;
      const next=e.key==='Home'?0:e.key==='End'?count-1:(index+(['ArrowLeft','ArrowUp'].includes(e.key)?count-1:1))%count;
      buttons[next].focus();choose(buttons[next].dataset.appearanceTheme);
    });
    document.querySelectorAll('[data-appearance-mode]').forEach(b=>b.addEventListener('click',()=>{preference.mode=b.dataset.appearanceMode;apply(true);}));
    document.getElementById('appearanceReset').addEventListener('click',()=>{preference=defaults();apply(true);});
    const tabs=[...document.querySelectorAll('[data-settings-panel]')];
    tabs.forEach(b=>b.addEventListener('click',()=>{
      tabs.forEach(tab=>tab.setAttribute('aria-pressed',String(tab===b)));
      document.querySelectorAll('.settings-content > section').forEach(panel=>panel.hidden=panel.dataset.settingsSection!==b.dataset.settingsPanel);
    }));
    apply();
  });
})();

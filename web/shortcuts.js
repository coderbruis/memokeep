/* Customization is a draft until Save succeeds; runtime bindings remain untouched. */
(() => {
  const api = window.MemoKeepShortcuts, entries = api.entries;
  const groups = [...new Set(entries.map(item => item.group))];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const entry = document.createElement('button');
  entry.id = 'shortcutEntry'; entry.type = 'button';
  entry.setAttribute('aria-label', '查看快捷键'); entry.setAttribute('aria-haspopup', 'dialog'); entry.setAttribute('aria-controls', 'shortcutDialog');
  entry.innerHTML = '<span class="shortcut-entry-symbol" aria-hidden="true">⌨</span><span class="shortcut-entry-tooltip" role="tooltip">快捷键</span>';
  const dialog = document.createElement('dialog'); dialog.id = 'shortcutDialog'; dialog.setAttribute('aria-labelledby', 'shortcutTitle');
  dialog.innerHTML = `<div class="shortcut-head"><div><h2 id="shortcutTitle">快捷键</h2><p>点击按键修改，按你的习惯操作</p></div><button class="shortcut-close" type="button" aria-label="关闭快捷键">Esc</button></div>
    <label class="shortcut-search"><svg aria-hidden="true"><use href="#icon-search"></use></svg><input type="search" aria-label="搜索快捷键" placeholder="搜索操作或按键" autocomplete="off" autofocus></label>
    <div class="shortcut-filters" role="group" aria-label="快捷键分类">${['全部',...groups].map((g,i)=>`<button type="button" aria-pressed="${!i}">${g}</button>`).join('')}</div>
    <div class="shortcut-list" tabindex="0" role="region" aria-label="快捷键列表"></div><p class="shortcut-search-status" role="status" aria-live="polite"></p>
    <div class="shortcut-platform">${api.isMac?'⌘ Command　⌥ Option　⇧ Shift':'Ctrl　Alt　Shift'}　 自定义设置仅保存在本机</div>
    <div class="shortcut-confirm" hidden role="alert"><span></span><button type="button" data-confirm-no>继续编辑</button><button type="button" data-confirm-yes>放弃更改</button></div>
    <footer><button type="button" class="shortcut-reset-all">恢复全部默认</button><div class="shortcut-save-area"><span role="status"></span><button type="button" class="shortcut-cancel">取消</button><button type="button" class="shortcut-save">保存更改</button></div></footer>`;
  document.body.append(entry,dialog);
  const input = dialog.querySelector('input'), list = dialog.querySelector('.shortcut-list'), confirm = dialog.querySelector('.shortcut-confirm');
  let draft = api.snapshot(), baseline = api.snapshot(), category = '全部', editing = null, candidate = null, candidateError = '', confirmation = null, externalChanged = false;
  const changed = () => entries.filter(item => draft[item.id] !== baseline[item.id]).length;
  const normalize = value => value.toLowerCase().normalize('NFKC').replace(/command|cmd/g,'⌘').replace(/option/g,'⌥').replace(/shift/g,'⇧').replace(/[\s+]+/g,'');
  const keycaps = binding => api.keys(binding).map(k=>`<kbd>${escape(k)}</kbd>`).join('');
  function footer(message) {
    dialog.querySelector('.shortcut-save-area span').textContent = message || (changed()?`${changed()} 项待保存`:'未修改');
    dialog.querySelector('.shortcut-save').disabled = !changed() || Boolean(editing) || externalChanged;
  }
  function render() {
    const scroll = list.scrollTop, query = normalize(input.value);
    const matches = entries.filter(item => (category==='全部'||category===item.group) && normalize(item.label+item.group+api.keys(draft[item.id]).join('')+draft[item.id]).includes(query));
    list.innerHTML = matches.length ? groups.map(group=> {
      const items = matches.filter(item=>item.group===group);
      return items.length ? `<section><h3>${group}</h3>${items.map(item=>`<div class="shortcut-item ${editing===item.id?'is-editing':''}" data-item="${item.id}"><div class="shortcut-row"><span>${item.label}${draft[item.id]!==api.defaults[item.id]?'<span class="shortcut-custom">自定义</span>':''}</span><span class="shortcut-row-actions">${draft[item.id]!==api.defaults[item.id]?`<button type="button" class="shortcut-reset-one" data-reset="${item.id}">恢复默认</button>`:''}<button type="button" class="shortcut-edit-key" data-edit="${item.id}" aria-label="修改${item.label}">${keycaps(draft[item.id])}<svg aria-hidden="true"><use href="#icon-pencil"></use></svg></button></span></div>${editing===item.id?`<div class="shortcut-recorder"><div class="shortcut-record-label">按下新的组合键</div><div class="shortcut-record-box" tabindex="0" role="group" aria-label="录入新的快捷键"></div><div class="shortcut-record-meta"><p role="status"></p><div><button type="button" data-record-cancel>取消</button><button type="button" data-record-apply>应用</button></div></div></div>`:''}</div>`).join('')}</section>`:'';
    }).join('') : '<div class="shortcut-empty"><strong>没有找到对应快捷键</strong><p>试试操作名称或按键，例如「保存」或「S」</p><button type="button" data-clear>清空搜索</button></div>';
    list.scrollTop=scroll; dialog.querySelector('.shortcut-search-status').textContent=`找到 ${matches.length} 个快捷键`;
    updateRecorder(); footer();
  }
  function updateRecorder() {
    const recorder = list.querySelector('.shortcut-recorder'); if(!recorder)return;
    recorder.classList.toggle('conflict',Boolean(candidateError));
    recorder.querySelector('.shortcut-record-box').innerHTML=candidate?keycaps(candidate):'<span>请按下组合键</span>';
    recorder.querySelector('p').textContent=candidateError||(candidate?'组合可用 · Enter 确认，Esc 取消':'按键只用于录入，不会触发操作');
    recorder.querySelector('[data-record-apply]').disabled=!candidate||Boolean(candidateError);
  }
  function endRecording(apply=false) {
    if(apply&&(!candidate||candidateError))return;
    const id=editing; if(apply)draft[id]=candidate;
    editing=null; candidate=null; candidateError=''; render(); list.querySelector(`[data-edit="${id}"]`)?.focus();
  }
  function showConfirmation(type,text,label) { confirmation=type;confirm.hidden=false;confirm.querySelector('span').textContent=text;confirm.querySelector('[data-confirm-yes]').textContent=label; }
  function requestClose() {
    if(editing){endRecording();return;}
    if(changed()){showConfirmation('discard','有未保存的修改，确定放弃吗？','放弃更改');return;}
    dialog.close();
  }
  // 关闭后焦点回到打开它的地方（侧栏「…」菜单里的项会随菜单收起，就回到「…」按钮）。
  let opener=null;
  entry.addEventListener('click',()=>{
    if(dialog.open)return;
    opener=document.activeElement&&document.activeElement!==document.body?document.activeElement:null;
    draft=api.snapshot();baseline=api.snapshot();category='全部';editing=null;candidate=null;candidateError='';externalChanged=false;confirm.hidden=true;input.value='';
    dialog.querySelectorAll('.shortcut-filters button').forEach(b=>b.setAttribute('aria-pressed',String(b.textContent===category)));
    render();list.scrollTop=0;dialog.showModal();input.focus();
  });
  dialog.querySelector('.shortcut-close').onclick=requestClose;dialog.querySelector('.shortcut-cancel').onclick=requestClose;
  dialog.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
  dialog.addEventListener('close',()=>{const visible=node=>node?.isConnected&&node.getClientRects().length;const target=[opener,opener?.closest?.('[role=menu]')?[...document.querySelectorAll('#sidebarMoreBtn,#sidebarWorkspaceBtn')].find(visible):null,document.querySelector('#sidebarMoreBtn'),entry].find(visible);target?.focus({preventScroll:true});});
  input.oninput=()=>{editing=null;render();list.scrollTop=0;};
  dialog.querySelectorAll('.shortcut-filters button').forEach(button=>button.onclick=()=>{category=button.textContent;editing=null;dialog.querySelectorAll('.shortcut-filters button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));render();list.scrollTop=0;});
  list.onclick=event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-clear')){input.value='';render();input.focus();}
    if(button.dataset.edit){editing=button.dataset.edit;candidate=null;candidateError='';render();const box=list.querySelector('.shortcut-record-box');box.focus();box.scrollIntoView({block:'nearest'});}
    if(button.dataset.reset){const id=button.dataset.reset,error=api.validate(id,api.defaults[id],draft);if(error){footer(error);return;}draft[id]=api.defaults[id];render();}
    if(button.hasAttribute('data-record-cancel'))endRecording();
    if(button.hasAttribute('data-record-apply'))endRecording(true);
  };
  dialog.querySelector('.shortcut-reset-all').onclick=()=>showConfirmation('reset','将所有快捷键恢复为默认组合？保存更改后生效。','恢复默认');
  confirm.querySelector('[data-confirm-no]').onclick=()=>{confirm.hidden=true;};
  confirm.querySelector('[data-confirm-yes]').onclick=()=>{
    confirm.hidden=true;
    if(confirmation==='discard')dialog.close();
    if(confirmation==='reset'){draft={...api.defaults};editing=null;render();}
    if(confirmation==='reload'){draft=api.snapshot();baseline=api.snapshot();externalChanged=false;editing=null;render();}
  };
  dialog.querySelector('.shortcut-save').onclick=()=>{
    if(editing||externalChanged)return;
    try{api.save(draft);baseline=api.snapshot();footer('已保存');}
    catch(error){footer(`保存失败：${error.message}`);}
  };
  window.addEventListener('storage',()=>{
    if(!dialog.open)return;
    const latest=api.snapshot();if(entries.every(item=>latest[item.id]===baseline[item.id]))return;
    externalChanged=true;showConfirmation('reload','快捷键已在另一窗口更新，请载入最新设置后继续。','载入最新');footer('其他窗口已更新');
  });
  let backdrop=false;
  const outside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',e=>{backdrop=outside(e);});
  dialog.addEventListener('click',e=>{if(backdrop&&outside(e))requestClose();backdrop=false;});
  window.addEventListener('keydown',event=>{
    if(!dialog.open)return;
    event.stopImmediatePropagation();
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();requestClose();return;}
    if(!editing||!event.target.closest?.('.shortcut-record-box'))return;
    if(event.key==='Tab')return;
    event.preventDefault();
    if(event.key==='Enter'){endRecording(true);return;}
    if(event.repeat||['Meta','Control','Alt','Shift'].includes(event.key))return;
    candidate=api.fromEvent(event);candidateError=api.validate(editing,candidate,draft);updateRecorder();
  },true);
})();

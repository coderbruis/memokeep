function bindNoteViewModes(root, trigger, {setImmersive, setReading, preserveSelection}) {
  const view=document.querySelector('#librariesView'), controller=new AbortController(), {signal}=controller;
  const menu=document.createElement('div');menu.className='note-view-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');menu.id='noteViewModes';
  menu.innerHTML=[['edit','沉浸式编辑','pencil'],['read','沉浸式阅读','book-open'],['eye','护眼模式','eye']].map(([mode,label,icon])=>`<button type="button" role="menuitemcheckbox" aria-checked="false" data-note-mode="${mode}" aria-label="${label}" data-tooltip="${label}"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></button>`).join('');
  root.append(menu);trigger.setAttribute('aria-controls',menu.id);
  let mode=view.classList.contains('note-reading')?'read':view.classList.contains('card-editor-immersive')?'edit':'',eye=false;
  try{eye=localStorage.getItem('memokeep-note-eye-mode')==='true'}catch{}
  const sync=()=>{
    view.classList.toggle('note-reading',mode==='read');view.classList.toggle('note-eye-mode',eye);
    setImmersive(Boolean(mode));setReading(mode==='read');
    menu.querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.noteMode==='eye'?eye:b.dataset.noteMode===mode)));
  };
  let restoreSelection=null;
  const close=()=>menu.hidePopover();
  trigger.onmousedown=e=>{e.preventDefault();restoreSelection=preserveSelection?.();};
  trigger.onclick=()=>{
    if(menu.matches(':popover-open')){close();return;}
    menu.showPopover();const rect=trigger.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-menu.offsetWidth-8))}px`;
    menu.style.top=`${Math.max(8,rect.top-menu.offsetHeight-8)}px`;
    menu.querySelector('button').focus({preventScroll:true});
  };
  menu.addEventListener('toggle',e=>trigger.setAttribute('aria-expanded',String(e.newState==='open')),{signal});
  const selectMode=selected=>{
    if(selected==='eye'){eye=!eye;try{localStorage.setItem('memokeep-note-eye-mode',String(eye))}catch{}}
    else mode=mode===selected?'':selected;
    close();sync();if(mode!=='read')restoreSelection?.();
  };
  menu.addEventListener('click',e=>{
    const selected=e.target.closest('[data-note-mode]')?.dataset.noteMode;if(selected)selectMode(selected);
  },{signal});
  const updateShortcutLabels=()=>menu.querySelectorAll('[data-note-mode]').forEach(button=>{
    button.dataset.tooltip=button.getAttribute('aria-label')+'  '+MemoKeepShortcuts.label('mode-'+button.dataset.noteMode);
  });
  updateShortcutLabels();
  window.addEventListener('memokeep-shortcuts-changed',updateShortcutLabels,{signal});
  window.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing||!root.isConnected||view.classList.contains('hidden')||!trigger.getClientRects().length||document.querySelector('dialog[open], [aria-modal="true"]:not(.hidden)'))return;
    const selected=['edit','read','eye'].find(name=>MemoKeepShortcuts.matches(e,'mode-'+name));
    if(!selected)return;
    e.preventDefault();e.stopImmediatePropagation();restoreSelection=preserveSelection?.();selectMode(selected);
  },{capture:true,signal});
  menu.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();close();trigger.focus();}
    if(['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(e.key)){
      e.preventDefault();const items=[...menu.querySelectorAll('button')],i=items.indexOf(document.activeElement);
      items[e.key==='Home'?0:e.key==='End'?2:(i+(['ArrowDown','ArrowRight'].includes(e.key)?1:2)+3)%3].focus();
    }
  },{signal});
  for(const type of ['paste','drop','cut','beforeinput'])root.addEventListener(type,e=>{if(mode==='read'&&!e.target.closest('.note-find-bar')){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,signal});
  root.addEventListener('keydown',e=>{
    if(mode==='read'&&!menu.contains(e.target)&&e.target!==trigger&&!e.target.closest('.note-find-bar')&&(e.key==='Backspace'||e.key==='Delete'||((e.ctrlKey||e.metaKey)&&['z','y','b','i','u'].includes(e.key.toLowerCase())))){e.preventDefault();e.stopImmediatePropagation();}
  },{capture:true,signal});
  root.addEventListener('click',e=>{
    if(mode==='read'&&e.target.closest('button')&&!menu.contains(e.target)&&!trigger.contains(e.target)&&!e.target.closest('#noteOutlinePanel, #noteOutlineHoverTarget, .note-selection-context-menu, .note-find-bar')){e.preventDefault();e.stopImmediatePropagation();}
  },{capture:true,signal});
  window.addEventListener('resize',close,{signal});
  sync();
  return ()=>{controller.abort();menu.remove();view.classList.remove('note-reading','note-eye-mode');};
}

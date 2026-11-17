function safeNoteLink(value) {
  try { const url = new URL(String(value).trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function readNoteLinkCard(node) {
  return { url: safeNoteLink(node.getAttribute('href')), title: node.querySelector('.note-link-title')?.textContent || node.getAttribute('href'),
    description: node.querySelector('.note-link-description')?.textContent || '', site: node.querySelector('.note-link-site')?.textContent || '',
    image: safeNoteLink(node.querySelector('img')?.getAttribute('src') || ''), loaded: node.dataset.noteLinkLoaded === 'true' };
}
function writeNoteLinkCard(node, value) {
  const url = safeNoteLink(value.url);
  node.setAttribute('href', url); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
  if(value.loaded) node.dataset.noteLinkLoaded = 'true';
  node.replaceChildren();
  if(safeNoteLink(value.image)) {
    const image=document.createElement('img'); image.className='note-link-cover'; image.src=value.image; image.alt=''; image.referrerPolicy='no-referrer';
    image.onerror=()=>{image.style.display='none';}; node.append(image);
  }
  const body=document.createElement('span');body.className='note-link-body';node.append(body);
  for (const [name, text] of [['title', value.title || url], ['description', value.description], ['site', value.site || (url ? new URL(url).hostname : '')]]) {
    if(!text)continue;
    const span = document.createElement('span'); span.className = `note-link-${name}`; span.textContent = text; body.append(span);
  }
}
function registerNoteLinkCard(registry, Quill) {
  class NoteLinkCard extends Quill.import('blots/embed') {
    static blotName = 'noteLinkCard'; static tagName = 'A'; static className = 'note-link-card';
    static create(value) { const node = super.create(); writeNoteLinkCard(node, value); return node; }
    static value(node) { return readNoteLinkCard(node); }
    position(index) { return [index > 0 ? this.rightGuard : this.leftGuard, 1]; }
  }
  registry.register(NoteLinkCard);
}
function serializeNoteLinkCards(root) {
  root.querySelectorAll('a.note-link-card').forEach(node => writeNoteLinkCard(node, readNoteLinkCard(node)));
}
function bindNoteLinkPaste(quill) {
  const controller = new AbortController(), { signal } = controller;
  const Delta = window.Quill.import('delta');
  const menu = document.createElement('div'); menu.className = 'note-link-menu'; menu.setAttribute('popover', 'auto');
  menu.innerHTML = `<div role="menu" aria-label="链接显示方式">${[['link','链接','link'],['title','标题','file-text'],['card','卡片','layers']].map(([type,label,icon]) => `<button type="button" role="menuitemradio" aria-checked="false" data-link-view="${type}">${icon === 'link' ? window.Quill.import('ui/icons').link : `<svg aria-hidden="true"><use href="#icon-${icon}"></use></svg>`}<span>${label}</span><span class="note-link-check">✓</span></button>`).join('')}</div><label>显示标题<input type="text" maxlength="300" aria-label="链接显示标题"></label><p class="note-link-status" role="status"></p><button type="button" data-link-refresh>重新获取网页信息</button>`;
  document.body.append(menu);
  let active = null, changing = false;
  const close = () => { menu.hidePopover(); active = null; };
  const position = () => {
    if (!active) return;
    const b = quill.getBounds(active.index, active.length), r = quill.container.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left + b.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(r.top + b.bottom + 8, innerHeight - menu.offsetHeight - 8))}px`;
  };
  const show = value => {
    active = value;
    menu.querySelector('input').value = value.title;
    menu.querySelectorAll('[data-link-view]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.linkView === value.type)));
    menu.showPopover(); position();
  };
  let requestId=0;
  const change = async (type, refresh=false) => {
    if (!active) return;
    const target=active, request=++requestId;
    let title = menu.querySelector('input').value.trim() || active.url;
    let metadata=active;
    if(type!=='link' && (!active.loaded || refresh) && window.memoKeepDesktop?.readLinkPreview) {
      menu.querySelector('.note-link-status').textContent='正在读取网页信息…';
      let result;try{result=await window.memoKeepDesktop.readLinkPreview(active.url)}catch{result={error:'无法读取网页'}}
      if(signal.aborted || active!==target || request!==requestId)return;
      if(!result.error) {
        metadata={...active,...result,loaded:true};
        if(title===active.title && result.title)title=result.title;
        menu.querySelector('.note-link-status').textContent='';
      } else menu.querySelector('.note-link-status').textContent='暂时无法读取网页，可稍后重试';
    }
    const insert = type === 'card' ? new Delta().insert({ noteLinkCard: {...metadata,url:active.url,title} }) : new Delta().insert(type === 'title' ? title : active.url, {link:active.url});
    changing = true; quill.history.cutoff();
    quill.updateContents(new Delta().retain(active.index).delete(active.length).concat(insert), 'user');
    quill.history.cutoff(); quill.setSelection(active.index + insert.length(), 0, 'silent'); changing = false;
    show({...active,...metadata, type, title, length:insert.length()});
  };
  menu.addEventListener('click', e => { if(e.target.closest('[data-link-refresh]')) {change(active?.type || 'card',true);return;} const type = e.target.closest('[data-link-view]')?.dataset.linkView; if(type) change(type); }, {signal});
  menu.addEventListener('keydown', e => {
    if(e.key === 'Escape') { e.preventDefault(); close(); quill.focus(); }
    else if(e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); change(active?.type || 'title'); }
    else if(['ArrowDown','ArrowUp'].includes(e.key) && e.target.tagName !== 'INPUT') {
      e.preventDefault(); const buttons=[...menu.querySelectorAll('button')], i=buttons.indexOf(document.activeElement);
      buttons[(i+(e.key==='ArrowDown'?1:2)+3)%3].focus();
    }
  }, {signal});
  quill.root.addEventListener('paste', event => {
    const raw = event.clipboardData?.getData('text/plain')?.trim();
    if (!/^https?:\/\/\S+$/i.test(raw || '') || [...(event.clipboardData?.items || [])].some(item=>item.kind==='file')) return;
    const url = safeNoteLink(raw), range = quill.getSelection(true);
    if (!url || !range || !quill.isEnabled()) return;
    const formats = quill.getFormat(range), last = quill.getLine(range.index+range.length)[0];
    if (formats['code-block'] || formats.code || quill.getLine(range.index)[0]?.formats().table || last?.formats().table) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const html = document.createElement('template'); html.innerHTML = event.clipboardData.getData('text/html') || '';
    const anchor = [...html.content.querySelectorAll('a')].find(a=>safeNoteLink(a.getAttribute('href'))===url);
    const parsed = new URL(url);
    let title = anchor?.textContent.trim();
    if (!title || safeNoteLink(title) === url) { try { title = parsed.hostname + decodeURIComponent(parsed.pathname).replace(/\/$/, ''); } catch { title = parsed.hostname; } }
    changing = true; quill.history.cutoff();
    quill.updateContents(new Delta().retain(range.index).delete(range.length).insert(url,{link:url}), 'user');
    quill.history.cutoff(); quill.setSelection(range.index+url.length,0,'silent'); changing = false;
    show({url,title,type:'link',index:range.index,length:url.length});
  }, {capture:true,signal});
  quill.root.addEventListener('click', event => {
    const anchor=event.target.closest('a'); if(!anchor || !quill.isEnabled()) return;
    if(event.metaKey || event.ctrlKey) return;
    const url=safeNoteLink(anchor.getAttribute('href')); if(!url) return;
    const blot=window.Quill.find(anchor); if(!blot) return;
    const card=anchor.classList.contains('note-link-card');
    const surface=card && anchor.querySelector(':scope > span[contenteditable=false]');
    if(surface && event.detail > 0 && event.clientX >= surface.getBoundingClientRect().right) {
      event.preventDefault(); close(); quill.setSelection(quill.getIndex(blot)+blot.length(),0,'user'); return;
    }
    event.preventDefault();
    show({...card ? readNoteLinkCard(anchor) : {},url,title:card ? anchor.querySelector('.note-link-title').textContent : anchor.textContent,type:card?'card':anchor.textContent===url?'link':'title',index:quill.getIndex(blot),length:blot.length()});
  }, {signal});
  const attempted=new WeakSet();let scanFrame;
  const scan=()=>{
    cancelAnimationFrame(scanFrame);scanFrame=requestAnimationFrame(()=>{
      if(signal.aborted || !window.memoKeepDesktop?.readLinkPreview)return;
      quill.root.querySelectorAll('a.note-link-card').forEach(async node=>{
        if(node.dataset.noteLinkLoaded==='true'||attempted.has(node))return;
        attempted.add(node);const original=readNoteLinkCard(node);
        let result;try{result=await window.memoKeepDesktop.readLinkPreview(original.url)}catch{return}
        if(result.error||signal.aborted||!quill.root.contains(node))return;
        const blot=window.Quill.find(node);if(!blot)return;
        const index=quill.getIndex(blot), selection=quill.getSelection();
        const parsed=new URL(original.url);let pathname=parsed.pathname;try{pathname=decodeURIComponent(pathname)}catch{}
        const fallback=parsed.hostname+pathname.replace(/\/$/,'');
        const title=original.title===fallback||original.title===original.url ? result.title||original.title : original.title;
        changing=true;
        quill.updateContents(new Delta().retain(index).delete(1).insert({noteLinkCard:{...original,...result,title,loaded:true}}),'user');
        if(selection)quill.setSelection(selection,'silent');changing=false;
      });
    });
  };
  quill.on('editor-change',scan);scan();
  const onChange = () => { if(!changing) close(); }; quill.on('text-change',onChange);
  window.addEventListener('resize', close, {signal});
  document.addEventListener('scroll', e=>{if(!menu.contains(e.target)) close();}, {capture:true,signal});
  return () => { controller.abort();cancelAnimationFrame(scanFrame);quill.off('editor-change',scan); quill.off('text-change',onChange); menu.remove(); };
}

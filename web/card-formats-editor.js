// Draft-only format controls; card writes remain in the existing card editor transaction.
(function expose(root) {
  function mount({ form, setField, changed, error, draftImage, uploadState, isSaving }) {
    const $ = id => document.getElementById(id), formats = window.MemoKeepCardFormats;
    const section = document.createElement('section'); section.className = 'ce-formats';
    section.innerHTML = `<div class="ce-format-row"><label>卡片类型<select id="cardFormatType" aria-label="卡片类型"><option value="qa">问答卡</option><option value="cloze">填空卡</option><option value="image-occlusion">图片遮挡</option></select></label><button type="button" id="cardInsertCloze" hidden>插入填空标记</button><label class="ce-reverse-option" id="cardReverseOption"><input type="checkbox" id="cardCreateReverse">同时创建反向卡</label></div><p id="cardFormatHint" class="ce-format-hint"></p><div id="cardOcclusionEditor" class="ce-occlusion-editor" hidden><div class="ce-occlusion-tools"><button type="button" id="cardOcclusionUpload">上传题图</button><select id="cardOcclusionExisting" aria-label="选择题目或答案已有图片"><option value="">选择已有图片</option></select><button type="button" id="cardOcclusionReset">重置遮挡区域</button><input type="file" id="cardOcclusionFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden></div><p class="ce-format-hint">拖动框选、移动或缩放；方向键微调。</p><div id="cardOcclusionStage" class="ce-occlusion-stage" tabindex="0" role="application" aria-label="图片遮挡区域编辑"><img id="cardOcclusionImage" alt="遮挡卡题图"><div id="cardOcclusionBox" class="ce-occlusion-box"><i aria-hidden="true"></i></div></div><div class="ce-occlusion-coordinates">${[['x','左侧 %'],['y','顶部 %'],['w','宽度 %'],['h','高度 %']].map(([key,label])=>`<label>${label}<input type="number" data-occlusion-key="${key}" aria-label="遮挡${label}" min="0" max="100" step="1"></label>`).join('')}</div></div>`;
    form.querySelector('#cardSettings').prepend(section);
    let value = { cardType: 'qa', imageOcclusion: null }, generation = 0, gesture = null, autoAnswer = '';
    const image = $('cardOcclusionImage'), box = $('cardOcclusionBox'), stage = $('cardOcclusionStage');
    const currentValue = () => ({ cardType: $('cardFormatType').value, ...($('cardFormatType').value === 'image-occlusion' ? { imageOcclusion: value.imageOcclusion && { ...value.imageOcclusion } } : {}), ...(value.reverseOf ? { reverseOf: value.reverseOf } : {}) });
    function notify() { changed(); }
    function paint() {
      const rect = value.imageOcclusion;
      stage.hidden = !rect; box.hidden = !rect;
      if (!rect) return;
      Object.assign(box.style, { left:rect.x*100+'%', top:rect.y*100+'%', width:rect.w*100+'%', height:rect.h*100+'%' });
      section.querySelectorAll('[data-occlusion-key]').forEach(input => { input.value = Math.round(rect[input.dataset.occlusionKey]*100); });
    }
    async function showImage(reference) {
      const active = ++generation;
      if (!reference) { image.removeAttribute('src'); paint(); return; }
      try {
        if (reference.startsWith('data:image/')) image.src = reference;
        else { const result = await window.memoKeepDesktop?.readNoteImage?.(reference.split('://')[1]); if (active !== generation) return; if (!result?.dataUrl) throw Error('原图片不可读取，请重新选择。'); image.src = result.dataUrl; }
      } catch (cause) { if (active === generation) error(cause.message || '图片读取失败'); }
      if (active === generation) paint();
    }
    function options() {
      const previous = $('cardOcclusionExisting').value, references = new Set();
      for (const id of ['question','answer']) for (const part of ReviewPresentation.contentParts($(id).value)) if (part.reference) references.add(part.reference);
      $('cardOcclusionExisting').replaceChildren(new Option('选择已有图片',''), ...[...references].map((reference,index)=>new Option('现有图片 '+(index+1),reference)));
      $('cardOcclusionExisting').value = previous;
    }
    function addReference(reference) {
      let question = $('question').value.replace(/!\[遮挡题图\]\(memokeep-image:\/\/[0-9a-f-]{36}(?:#w=\d+)?\)/gi,'').trim();
      if (!question) question = '图中被遮挡的内容是什么？';
      if (reference.startsWith('memokeep-image://') && !question.includes(reference)) question += `\n![遮挡题图](${reference}#w=100)`;
      setField('question',question);
    }
    function setReference(reference) {
      value.imageOcclusion = formats.normalizeOcclusion({reference,x:.15,y:.2,w:.35,h:.2});
      if (!value.imageOcclusion) { error('图片格式不受支持'); return; }
      addReference(reference); void showImage(reference); notify();
    }
    function typeChanged() {
      const type = $('cardFormatType').value;
      $('cardInsertCloze').hidden = type !== 'cloze'; $('cardOcclusionEditor').hidden = type !== 'image-occlusion'; $('cardReverseOption').hidden = type !== 'qa';
      if (type !== 'qa') $('cardCreateReverse').checked = false;
      $('cardFormatHint').textContent = type === 'cloze' ? '填空格式：{{c1::答案}}' : ''; $('cardFormatHint').hidden = type !== 'cloze';
      options(); paint(); notify();
    }
    $('cardFormatType').onchange = typeChanged;
    $('cardCreateReverse').onchange = notify;
    $('cardInsertCloze').onpointerdown = event => event.preventDefault();
    $('cardInsertCloze').onclick = () => {
      const selected = window.getSelection()?.toString(); let question = $('question').value;
      question = selected && question.includes(selected) ? question.replace(selected,`{{c1::${selected}}}`) : (question ? question+' ' : '知识点是')+'{{c1::答案}}';
      setField('question',question); if (!$('answer').value.trim()) setField('answer',formats.clozeAnswer(question)); notify();
    };
    $('questionEditor').addEventListener('input',()=>{Promise.resolve().then(()=>{if($('cardFormatType').value==='cloze'&&(!$('answer').value.trim()||$('answer').value===autoAnswer)){const answer=formats.clozeAnswer($('question').value);if(answer){autoAnswer=answer;if($('answer').value!==answer)setField('answer',answer)}}})});
    $('cardOcclusionUpload').onclick = () => { options(); $('cardOcclusionFile').click(); };
    $('cardOcclusionExisting').onchange = event => { if(event.target.value)setReference(event.target.value); };
    $('cardOcclusionReset').onclick = () => { if(value.imageOcclusion){Object.assign(value.imageOcclusion,{x:.15,y:.2,w:.35,h:.2});paint();notify()} };
    $('cardOcclusionFile').onchange = async event => {
      const file = event.target.files[0]; event.target.value = ''; if (!file) return;
      if (file.size > 10*1024*1024) { error('题图需小于10 MB'); return; }
      const active = generation; uploadState(1);
      try {
        let reference;
        if (window.memoKeepDesktop?.saveNoteImage) { const saved=await window.memoKeepDesktop.saveNoteImage({bytes:new Uint8Array(await file.arrayBuffer()),name:file.name,mimeType:file.type}); if(active!==generation){window.memoKeepDesktop.deleteNoteImage?.(saved.id).catch(()=>{});return} draftImage(saved.id);reference=saved.reference; }
        else reference=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});
        if(active===generation)setReference(reference);
      } catch(cause) { if(active===generation)error(`题图保存失败：${cause.message||'请重试'}`); }
      finally { uploadState(-1); }
    };
    function clamp() { if(value.imageOcclusion)value.imageOcclusion=formats.normalizeOcclusion(value.imageOcclusion); }
    stage.onpointerdown = event => {
      if(isSaving()||!value.imageOcclusion||event.button)return;
      event.preventDefault();stage.focus();const bounds=image.getBoundingClientRect(),x=(event.clientX-bounds.left)/bounds.width,y=(event.clientY-bounds.top)/bounds.height;
      gesture={x,y,original:{...value.imageOcclusion},mode:event.target.tagName==='I'?'resize':event.target===box?'move':'new'};
      if(gesture.mode==='new')Object.assign(value.imageOcclusion,{x,y,w:.03,h:.03});stage.setPointerCapture(event.pointerId);clamp();paint();
    };
    stage.onpointermove = event => {
      if(!gesture||isSaving())return;const bounds=image.getBoundingClientRect(),dx=(event.clientX-bounds.left)/bounds.width-gesture.x,dy=(event.clientY-bounds.top)/bounds.height-gesture.y,q=value.imageOcclusion;
      if(gesture.mode==='move'){q.x=Math.max(0,Math.min(1-q.w,gesture.original.x+dx));q.y=Math.max(0,Math.min(1-q.h,gesture.original.y+dy))}
      else if(gesture.mode==='resize'){q.w=gesture.original.w+dx;q.h=gesture.original.h+dy}
      else{q.x=Math.min(gesture.x,gesture.x+dx);q.y=Math.min(gesture.y,gesture.y+dy);q.w=Math.abs(dx);q.h=Math.abs(dy)}
      clamp();paint();notify();
    };
    stage.onpointerup=stage.onpointercancel=()=>{gesture=null};
    stage.onkeydown=event=>{if(!value.imageOcclusion||isSaving()||!event.key.startsWith('Arrow'))return;event.preventDefault();const q=value.imageOcclusion,delta=(event.shiftKey?10:1)/Math.max(1,image.clientWidth);if(event.key==='ArrowLeft')q.x-=delta;if(event.key==='ArrowRight')q.x+=delta;if(event.key==='ArrowUp')q.y-=delta;if(event.key==='ArrowDown')q.y+=delta;q.x=Math.max(0,Math.min(1-q.w,q.x));q.y=Math.max(0,Math.min(1-q.h,q.y));clamp();paint();notify()};
    section.querySelectorAll('[data-occlusion-key]').forEach(input=>input.onchange=()=>{if(!value.imageOcclusion)return;value.imageOcclusion[input.dataset.occlusionKey]=Number(input.value)/100;clamp();paint();notify()});
    form.closest('dialog').addEventListener('close',()=>{generation++;gesture=null});
    return { value:currentValue, createReverse:()=>$('cardCreateReverse').checked, validate:()=>formats.validateCardFormat({...currentValue(),question:$('question').value}), reset(card={}) {generation++;autoAnswer=formats.clozeAnswer(card.question||'');value={...formats.normalizeCardFormat(card),imageOcclusion:formats.normalizeOcclusion(card.imageOcclusion)};$('cardFormatType').value=value.cardType;$('cardCreateReverse').checked=false;typeChanged();void showImage(value.imageOcclusion?.reference);}, refresh:options };
  }
  root.MemoKeepCardFormatsEditor = { mount };
})(globalThis);

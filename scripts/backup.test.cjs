const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { backupSummary, createPortableBackup, validatePortableBackup, installBackupMedia } = require('./legacy-import/backup.cjs');
const { readNoteImage } = require('./legacy-import/note-images.cjs');
const oldId = 'cddae675-38fc-4487-a14a-30a398663ed4';
const newId = '81785119-c923-4b43-aa11-f7ece2b9d93b';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('GIF89a01020304050607');
const data = (label, ids = [oldId]) => ({version:2,knowledgeBases:[{id:'library',name:label}],documents:[{id:'note',title:label,content:ids.map(id=>`memokeep-image://${id}`).join(' '),metadata:{versions:[{content:'history'}]}}],cardDocuments:[],items:[],cards:[{id:'card',question:label,answer:'answer',cardType:'cloze',source:{documentId:'note',quote:label},schedulerData:{state:2}}],reviewRecords:[{id:'review',rating:'good'}],memos:[],cardCandidates:[],sourceChanges:[],trash:[],settings:{knowledgeStoragePath:''}});
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'memokeep-backup-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'images'));
 await fs.writeFile(path.join(root,'images',`${oldId}.gif`),gif);return root;
}
const media = (id, bytes=png, extension='png')=>({id,bytes,extension,mimeType:extension==='gif'?'image/gif':'image/png'});
async function listing(root) {const result={};for(const name of (await fs.readdir(path.join(root,'images'))).sort())result[name]=(await fs.readFile(path.join(root,'images',name))).toString('base64');return result;}
test('complete backup includes references from cards, versions, trash, memos and candidates once', async t=>{
 const root=await fixture(t),input=data('original');input.cards[0].answer=`memokeep-image://${oldId}`;input.documents[0].metadata.versions[0].noteContent=`memokeep-image://${newId}`;input.trash=[{id:'trash',document:{content:`memokeep-image://${newId}`}}];input.memos=[{id:'memo',notes:`memokeep-image://${oldId}`}];input.cardCandidates=[{id:'candidate',question:`memokeep-image://${newId}`}];await fs.writeFile(path.join(root,'images',`${newId}.png`),png);
 const backup=await createPortableBackup(input,id=>readNoteImage(root,id)),parsed=validatePortableBackup(JSON.parse(JSON.stringify(backup)));
 assert.equal(backup.backup.media.length,2);assert.deepEqual(parsed.data,input);assert.equal(parsed.legacy,false);assert.equal(parsed.summary.versions,1);assert.deepEqual(parsed.media.find(m=>m.id===newId).bytes,png);
});
test('invalid, missing and altered media are rejected before installation',async()=>{
 const backup=await createPortableBackup(data('valid'),async()=>({mimeType:'image/png',dataUrl:`data:image/png;base64,${png.toString('base64')}`}));
 for(const alter of [b=>b.backup.media.pop(),b=>b.backup.media[0].sha256='0'.repeat(64),b=>b.backup.media[0].id='../escape',b=>b.documents.push(b.documents[0]),b=>b.backup.media[0].data='AAAA']){const altered=structuredClone(backup);alter(altered);assert.throws(()=>validatePortableBackup(altered));}
 await assert.rejects(createPortableBackup(data('missing'),async()=>null),/完整备份未导出/);
 assert.throws(()=>validatePortableBackup({...data('wrong'),reviewRecords:'not-a-list'}),/列表/);
 assert.throws(()=>validatePortableBackup(JSON.parse('{"cards":[],"documents":[],"__proto__":{"polluted":true}}')),/有效/);
});
test('media installation and explicit rollback restore exact old files and preserve unrelated media',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'images','unrelated.txt'),'safe');const before=await listing(root);
 const rollback=await installBackupMedia(root,[media(oldId),media(newId)]);assert.deepEqual((await readNoteImage(root,oldId)).mimeType,'image/png');await rollback();assert.deepEqual(await listing(root),before);
});
test('media installation failure rolls back prior replacements and cleans temporary files',async t=>{
 const root=await fixture(t),before=await listing(root),rename=fs.rename;let calls=0;fs.rename=async(...args)=>{if(++calls===2)throw Error('Expected rename failure');return rename(...args)};
 try{await assert.rejects(installBackupMedia(root,[media(oldId),media(newId)]),/Expected rename/);}finally{fs.rename=rename}
 assert.deepEqual(await listing(root),before);
});
async function browserSettings(initial) {
 const state={persistence:{data:structuredClone(initial)},shell:{},knowledge:{}},toasts=[];let preview,restore;const actions={normalize:structuredClone,showConfirmDialog:async()=>true,renderAll:()=>{},showToast:(...args)=>toasts.push(args),showBackupPreview:(p,apply)=>{preview=p;restore=apply}};
 const application={state:{read:()=>state.persistence.data},editor:{session:{flushNoteTabsForWindowClose:async()=>true}},persistence:{transact:async mutate=>{const next=structuredClone(state.persistence.data);mutate(next);state.persistence.data=next}}};
 const context={globalThis:{}};vm.createContext(context);vm.runInContext(await fs.readFile(path.join(__dirname,'../web/shell/settings.js'),'utf8'),context);Object.assign(actions,context.globalThis.MemoKeepShell.createSettings({state,config:{},actions,env:{application,structuredClone}}));actions.showBackupPreview=(p,apply)=>{preview=p;restore=apply};
 return {state,actions,toasts,import:async next=>{await actions.handleWebBackupInput({target:{files:[{name:'backup.json',size:500,text:async()=>JSON.stringify(next)}]}});assert(preview);return restore()}};
}
test('browser restore preserves local directory and refuses undo after edits',async()=>{
 const original=data('browser'),f=await browserSettings(original),next=data('replacement',[]);next.settings.knowledgeStoragePath='/another-device';await f.import(next);assert.equal(f.state.persistence.data.settings.knowledgeStoragePath,'');f.state.persistence.data.cards[0].answer='new edit';await f.actions.undoBackupRestore();assert.equal(f.state.persistence.data.cards[0].answer,'new edit');assert(f.toasts.some(([message])=>message.includes('已有新的修改')));
});
test('browser preflight rejects malformed optional lists before offering a preview',async()=>{
 const f=await browserSettings(data('browser'));assert.throws(()=>f.actions.backupCounts({...data('bad'),reviewRecords:'bad'}),/列表/);
});

test('browser refuses extension attachments without applying a partial restore',async()=>{
 const original=data('keep'),f=await browserSettings(original);
 const incoming={...data('incoming'),backup:{version:2,mediaIncluded:true,extensions:{'fixture.attachments':{version:1,metadata:{},attachments:[]}}}};
 await f.actions.handleWebBackupInput({target:{files:[{name:'extended.json',size:500,text:async()=>JSON.stringify(incoming)}]}});
 assert.deepEqual(f.state.persistence.data,original);
 assert(f.toasts.some(([message])=>message.includes('扩展附件')));
});

test('restore preview shows generic extension counts and escaped warnings before confirmation',async()=>{
 const window=require('@mixmark-io/domino').createWindow('<!doctype html><html><body></body></html>'),document=window.document;
 // Domino supplies the DOM but not browser focus behavior.
 window.HTMLElement.prototype.focus=()=>{};
 if(!window.Element.prototype.append)window.Element.prototype.append=function(...nodes){nodes.forEach(node=>this.appendChild(node))};
 const previewDocument={body:document.body,createElement:tag=>{
  const node=document.createElement(tag);if(tag==='dialog')Object.defineProperties(node,{
   showModal:{value:()=>node.setAttribute('open','')},close:{value:()=>{node.removeAttribute('open');node.dispatchEvent(new window.Event('close'))}}
  });return node;
 }};
 const nodeList=Object.getPrototypeOf(document.querySelectorAll('button'));if(!nodeList.forEach)nodeList.forEach=Array.prototype.forEach;
 const actions={escapeHtml:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
 const context={globalThis:{}};vm.createContext(context);vm.runInContext(await fs.readFile(path.join(__dirname,'../web/shell/settings.js'),'utf8'),context);
 Object.assign(actions,context.globalThis.MemoKeepShell.createSettings({state:{persistence:{data:data('current')},shell:{}},config:{desktop:{importBackup:async()=>null}},actions,env:{document:previewDocument}}));
 actions.showBackupPreview({name:'extended.json',summary:{},extensions:{fixture:{label:'<img>Attachment',attachments:2,missing:1}},warnings:['Missing bytes: <img src=x>']},async()=>{throw Error('must not apply while checking preview')});
 const dialog=document.querySelector('#backupRestorePreview');
 assert.match(dialog.querySelector('[data-backup-extension]').textContent,/<img>Attachment.*可恢复 2 · 缺少 1/);
 assert.match(dialog.querySelector('[data-backup-warning]').textContent,/Missing bytes: <img src=x>/);
 assert.equal(dialog.querySelectorAll('img').length,0);
 assert(dialog.hasAttribute('open'));
});

test('occlusion-only image references survive complete backup across cards, candidates and trash',async()=>{
 const {dataImageIds}=require('../web/domain/image-references.js'),ids=[oldId,newId,'3d90e5ae-8959-42eb-bae1-d48abcf5627c','904ded01-c416-46e2-a1ef-cedd659bb279'];
 const input=data('occlusion',[]),occlusion=id=>({id,question:'image question',answer:'answer',imageOcclusion:{reference:`memokeep-image://${id}`}});
 input.cards=[occlusion(ids[0])];input.cardCandidates=[occlusion(ids[1])];input.trash=[{id:'trash-1',card:occlusion(ids[2])},{id:'trash-2',cards:[occlusion(ids[3])]}];
 assert.deepEqual(new Set(dataImageIds(input)),new Set(ids));const backup=await createPortableBackup(input,async()=>({mimeType:'image/png',dataUrl:`data:image/png;base64,${png.toString('base64')}`}));assert.equal(backup.backup.media.length,4);assert.equal(validatePortableBackup(backup).media.length,4);
});

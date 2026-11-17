const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { backupSummary, createPortableBackup, validatePortableBackup, installBackupMedia } = require('../electron/backup.cjs');
const { readNoteImage } = require('../electron/note-images.cjs');
const { stateValuesEqual } = require('../web/state-merge.js');
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
async function handlers(t, initial, options={}) {
 const root=await fixture(t),file=path.join(root,'state.json');await fs.writeFile(file,JSON.stringify(initial));let queue=Promise.resolve(),writes=0,fail=0;
 const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
 const enqueueDataWrite=work=>{const p=queue.then(work);queue=p.catch(()=>{});return p;};
 const persistData=async next=>{writes++;if(fail===1){fail=0;throw Error('Expected write failure');}await fs.writeFile(file,JSON.stringify(next));if(fail===2){fail=0;throw Error('Expected publication failure');}return structuredClone(next);};
 const context={fs,path,randomUUID,structuredClone,Date,Error,createPortableBackup,validatePortableBackup,installBackupMedia:options.install||installBackupMedia,stateValuesEqual,readData:read,normalizeData:input=>structuredClone(input),noteImageRoot:()=>root,readStoredNoteImage:(_data,id)=>readNoteImage(root,id),writeData:next=>enqueueDataWrite(()=>persistData(next)),persistData,enqueueDataWrite,mainWindow:null,noteWindows:[],canSendToWindow:()=>false,windowDataSnapshots:new Map(),dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[path.join(root,'backup.json')]}),showSaveDialog:async()=>({canceled:false,filePath:path.join(root,'export.json')})}};
 Object.defineProperty(context,'dataWriteQueue',{get:()=>queue});
 const source=await fs.readFile(path.join(__dirname,'../electron/main.cjs'),'utf8');vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let pendingBackupRestore ='),source.indexOf('\nfunction csvEscape')),context);
 return {root,file,context,read,get writes(){return writes;},setFail:value=>{fail=value},edit:mutate=>enqueueDataWrite(async()=>{const next=await read();mutate(next);return persistData(next);}),import:(value)=>context.importBackup(null,value),apply:candidate=>context.applyBackupRestore(candidate),choose:async backup=>fs.writeFile(path.join(root,'backup.json'),JSON.stringify(backup))};
}

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
test('preview, cancellation and invalid token leave data and image files unchanged',async t=>{
 const f=await handlers(t,data('original')),before=await fs.readFile(f.file,'utf8'),images=await listing(f.root),backup=await createPortableBackup(data('replacement'),id=>readNoteImage(f.root,id));await f.choose(backup);
 const preview=await f.import({preview:true});assert.equal(preview.summary.cards,1);assert.equal(f.writes,0);await f.import({cancel:preview.token});await assert.rejects(f.import({apply:preview.token}),/过期/);assert.equal(await fs.readFile(f.file,'utf8'),before);assert.deepEqual(await listing(f.root),images);
});
test('failed data write and failed post-write publication restore original data and media; retry succeeds',async t=>{
 for(const failure of [1,2]){const original=data('original'),f=await handlers(t,original),before=await listing(f.root),replacement=data('replacement',[oldId,newId]);const candidate={data:replacement,media:[media(oldId),media(newId)]};f.setFail(failure);await assert.rejects(f.apply(candidate),/Expected/);assert.deepEqual(await f.read(),original);assert.deepEqual(await listing(f.root),before);await f.apply(candidate);assert.equal((await f.read()).cards[0].question,'replacement');}
});
test('restore preserves device directory, undo restores snapshot, later edits forbid undo',async t=>{
 const original=data('original'),f=await handlers(t,original),replacement=data('replacement');replacement.settings.knowledgeStoragePath='/another-device';await f.apply({data:replacement,media:[media(oldId)]});assert.equal((await f.read()).settings.knowledgeStoragePath,'');await f.import({undo:true});assert.deepEqual(await f.read(),original);assert.equal((await readNoteImage(f.root,oldId)).mimeType,'image/gif');await f.apply({data:replacement,media:[media(oldId)]});await f.edit(next=>next.cards[0].answer='edited after restore');await assert.rejects(f.import({undo:true}),/已有新的修改/);assert.equal((await f.read()).cards[0].answer,'edited after restore');assert.equal((await f.import({status:true})).canUndo,false);
});
test('queued edits cannot interleave between restore media installation and data commit',async t=>{
 let started,release;const atMedia=new Promise(r=>started=r),unblock=new Promise(r=>release=r);const f=await handlers(t,data('original'),{install:async(...args)=>{started();await unblock;return installBackupMedia(...args)}});
 const restore=f.apply({data:data('replacement'),media:[media(oldId)]});await atMedia;const edit=f.edit(next=>next.cards[0].answer='concurrent edit');release();await Promise.all([restore,edit]);assert.equal((await f.read()).cards[0].question,'replacement');assert.equal((await f.read()).cards[0].answer,'concurrent edit');
});

test('a preview cannot be applied twice while its first restore is running',async t=>{
 let started,release;const atMedia=new Promise(r=>started=r),unblock=new Promise(r=>release=r);const f=await handlers(t,data('original'),{install:async(...args)=>{started();await unblock;return installBackupMedia(...args)}});await f.choose(await createPortableBackup(data('replacement'),id=>readNoteImage(f.root,id)));const p=await f.import({preview:true}),first=f.import({apply:p.token});await atMedia;const duplicate=assert.rejects(f.import({apply:p.token}),/正在恢复/);release();await Promise.all([first,duplicate]);await f.import({undo:true});assert.equal((await f.read()).cards[0].question,'original');
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

test('occlusion-only image references survive complete backup across cards, candidates and trash',async()=>{
 const {dataImageIds}=require('../web/domain/image-references.js'),ids=[oldId,newId,'3d90e5ae-8959-42eb-bae1-d48abcf5627c','904ded01-c416-46e2-a1ef-cedd659bb279'];
 const input=data('occlusion',[]),occlusion=id=>({id,question:'image question',answer:'answer',imageOcclusion:{reference:`memokeep-image://${id}`}});
 input.cards=[occlusion(ids[0])];input.cardCandidates=[occlusion(ids[1])];input.trash=[{id:'trash-1',card:occlusion(ids[2])},{id:'trash-2',cards:[occlusion(ids[3])]}];
 assert.deepEqual(new Set(dataImageIds(input)),new Set(ids));const backup=await createPortableBackup(input,async()=>({mimeType:'image/png',dataUrl:`data:image/png;base64,${png.toString('base64')}`}));assert.equal(backup.backup.media.length,4);assert.equal(validatePortableBackup(backup).media.length,4);
});
test('successful restore invalidates the importing window patch snapshot and notifies peer windows',async t=>{
 const f=await handlers(t,data('original')),events=[],sender={id:21},peer={webContents:{send:channel=>events.push(channel)}};
 f.context.mainWindow=peer;f.context.canSendToWindow=window=>Boolean(window);f.context.windowDataSnapshots.set(sender.id,{token:1,data:data('original')});await f.choose(await createPortableBackup(data('replacement'),id=>readNoteImage(f.root,id)));const preview=await f.import({preview:true});await f.context.importBackup({sender},{apply:preview.token});assert.equal(f.context.windowDataSnapshots.has(sender.id),false);assert.deepEqual(events,['data:changed']);
});

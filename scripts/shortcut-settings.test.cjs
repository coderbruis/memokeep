const test = require('node:test'), assert = require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/shortcut-settings.js'),'utf8');
function create(platform='MacIntel', storage=new Map(), shortcuts=[]) {
 const context={MemoKeepEdition:{shortcuts},navigator:{platform},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},Event:class{},dispatchEvent:()=>{},addEventListener:()=>{}};
 vm.runInNewContext(source,context);return context.MemoKeepShortcuts;
}
test('all defaults valid on Mac and Windows, Option physical codes stable',()=>{
 for(const platform of ['MacIntel','Win32']){const api=create(platform);for(const item of api.entries)assert.equal(api.validate(item.id,api.defaults[item.id],api.defaults),'',item.id);}
 const api=create();assert.equal(api.fromEvent({key:'¡',code:'Digit1',metaKey:true,altKey:true}),'Meta+Alt+Digit1');
 assert.equal(api.matches({code:'Digit1',metaKey:true,altKey:true},'mode-edit'),true);
 assert.equal(api.matches({code:'Digit1',metaKey:true,altKey:true,shiftKey:true},'mode-edit'),false);
 assert.equal(api.matches({code:'Digit1',metaKey:true,altKey:true,isComposing:true},'mode-edit'),false);
});
test('collision, editing/system reservation, unmodified note bindings rejected',()=>{
 const api=create(),draft=api.snapshot();assert.match(api.validate('save','Meta+KeyW',draft),/关闭/);
 assert.match(api.validate('save','KeyS',draft),/Command/);assert.match(api.validate('save','Meta+KeyC',draft),/系统/);
 assert.match(api.validate('save','Meta+KeyQ',draft),/系统/);assert.match(api.validate('save','Escape',draft),/请使用/);
 assert.equal(api.validate('save','Meta+Shift+KeyS',draft),'');
});
test('save, old binding disabled, reload persistence, corrupted storage fallback',()=>{
 const store=new Map(),api=create('MacIntel',store),draft=api.snapshot();draft.save='Meta+Shift+KeyS';api.save(draft);
 assert.equal(api.matches({code:'KeyS',metaKey:true},'save'),false);assert.equal(api.matches({code:'KeyS',metaKey:true,shiftKey:true},'save'),true);
 assert.equal(create('MacIntel',store).snapshot().save,draft.save);
 store.set('memokeep-shortcuts-v1','{broken');assert.equal(create('MacIntel',store).snapshot().save,'Meta+KeyS');
});
test('edition shortcuts use platform defaults and keep customized bindings',()=>{
 const additions=[{id:'custom-action',group:'笔记编辑',label:'自定义操作',binding:'Control+Alt+KeyE',macBinding:'Meta+Control+KeyE'}];
 const store=new Map(),api=create('MacIntel',store,additions);
 assert.equal(create().entries.some(item=>item.id==='custom-action'),false);
 assert.equal(api.defaults['custom-action'],'Meta+Control+KeyE');
 assert.equal(api.matches({code:'KeyE',metaKey:true,ctrlKey:true},'custom-action'),true);
 assert.equal(api.matches({code:'KeyE',metaKey:true},'custom-action'),false);
 assert.equal(api.matches({code:'KeyE',metaKey:true,ctrlKey:true,repeat:true},'custom-action'),false);
 assert.equal(create('Win32',new Map(),additions).defaults['custom-action'],'Control+Alt+KeyE');
 const draft=api.snapshot();assert.match(api.validate('custom-action','Meta+KeyS',draft),/保存笔记/);
 draft['custom-action']='Meta+Alt+KeyG';api.save(draft);
 assert.equal(create('MacIntel',store,additions).snapshot()['custom-action'],'Meta+Alt+KeyG');
 assert.equal(api.matches({code:'KeyE',metaKey:true,ctrlKey:true},'custom-action'),false);
 const saved=JSON.parse(store.get('memokeep-shortcuts-v1'));delete saved.bindings['custom-action'];saved.bindings.save='Meta+Shift+KeyS';
 store.set('memokeep-shortcuts-v1',JSON.stringify(saved));
 const old=create('MacIntel',store,additions);assert.equal(old.snapshot().save,'Meta+Shift+KeyS');assert.equal(old.snapshot()['custom-action'],old.defaults['custom-action']);
});

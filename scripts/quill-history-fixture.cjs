const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const quillDirectory=path.dirname(require.resolve('quill'));
// Run the installed Quill History implementation with real Delta values; no browser or native window.
const Delta=require('quill-delta');
const HistorySource=fs.readFileSync(path.join(quillDirectory,'modules/history.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/^export \{.*;$/m,'');
const ModuleSource=fs.readFileSync(path.join(quillDirectory,'core/module.js'),'utf8').replace(/^export default Module;$/m,'');
const Q={events:{EDITOR_CHANGE:'editor-change',SELECTION_CHANGE:'selection-change',TEXT_CHANGE:'text-change'},sources:{USER:'user',SILENT:'silent'}};
const QuillSource=fs.readFileSync(path.join(quillDirectory,'core/quill.js'),'utf8');
const selectionMethod=vm.runInNewContext('class SelectionProbe {'+QuillSource.slice(QuillSource.indexOf('  getSelection() {'),QuillSource.indexOf('  getSemanticHTML() {'))+'}; SelectionProbe.prototype.getSelection;');
const History=vm.runInNewContext(ModuleSource+'\n'+HistorySource+'\nHistory;',{Quill:Q,Scope:{BLOCK:1},navigator:{platform:'MacIntel'},Date});
const domino=require('@mixmark-io/domino');
function quillHistoryFixture(){
 const window=domino.createWindow('<div id="editor"></div>'),root=window.document.querySelector('#editor');
 Object.getPrototypeOf(root.querySelectorAll('img'))[Symbol.iterator]=Array.prototype.values;
 let contents=new Delta().insert('base\n'),pending=null;const callbacks=[];let history;let range={index:0,length:1};
 const render=()=>{root.textContent=contents.ops.map(op=>typeof op.insert==='string'?op.insert:'[image]').join('');};
 const emit=(change,old,source)=>callbacks.forEach(fn=>fn(Q.events.TEXT_CHANGE,change,old,source));
 const apply=(delta,source='user')=>{const old=contents;contents=contents.compose(delta);render();emit(delta,old,source);};
 const quill={root,on(event,fn){callbacks.push(fn);},keyboard:{addBinding(){}},scroll:{query:()=>null},
  getContents:()=>new Delta(contents.ops),getModule:()=>history,getSelection:selectionMethod,selection:{getRange:()=>[{...range}]},update(){if(pending){const delta=pending;pending=null;apply(delta);}},
  setSelection(index,length){range=typeof index==='object'?{...index}:{index,length:typeof length==='number'?length:0};},
  updateContents:apply,setContents(value,source){const old=contents;contents=new Delta(value.ops);render();emit(old.diff(contents),old,source);}};
 history=new History(quill,{...History.DEFAULTS});render();return{quill,history,apply,contents:()=>contents,pending:delta=>{pending=delta;}};
}

module.exports={quillHistoryFixture,Delta};

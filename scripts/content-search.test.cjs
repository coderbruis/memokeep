const test=require('node:test'),assert=require('node:assert/strict');
const {searchContent}=require('../web/domain/content-search.js');
const data={noteTags:[{id:'tag',name:'网络'}],documents:[{id:'n',title:'接口约定',tagIds:['tag'],metadata:{noteContent:'<p>超时设为两秒</p>'}}],items:[{id:'i',documentId:'n',content:'只重试幂等请求'}],cards:[{id:'c',question:'幂等是什么',answer:'重复执行结果一致',knowledgeItemId:'i',tags:['协议']}],memos:[{id:'m',title:'整理笔记',notes:'<p>检查网络知识</p>'}]};
test('global search covers rich note text, tags, card source and memos',()=>{assert.equal(searchContent(data,'两秒')[0].id,'n');assert.equal(searchContent(data,'接口约定 幂等')[0].id,'c');assert.equal(searchContent(data,'整理')[0].id,'m');assert(searchContent(data,'网络').some(e=>e.id==='n'));});
test('all search terms match and empty search stays quiet',()=>{assert.deepEqual(searchContent(data,''),[]);assert.deepEqual(searchContent(data,'幂等 不存在'),[]);assert.equal(searchContent(data,'幂等',1).length,1);});

test('card-note body is searched once and routes through its notebook owner',()=>{const input={...data,cardDocuments:[{id:'cd',title:'行卡文档',content:'术语==定义'}],cardNotebooks:[{id:'nb',name:'卡片笔记',sourceDocumentId:'cd'}]};const matches=searchContent(input,'术语');assert.equal(matches.length,1);assert.equal(matches[0].kind,'notebook');assert.equal(matches[0].id,'nb');});

test('ancestor tag names are searchable and malformed cycles terminate',()=>{const input={...data,noteTags:[{id:'parent',name:'计算机科学'},{id:'tag',name:'网络',parentId:'parent'}]};assert.equal(searchContent(input,'计算机科学 两秒')[0].id,'n');input.noteTags[0].parentId='tag';assert.equal(searchContent(input,'计算机科学 两秒')[0].id,'n');});

test('results carry where they live so the palette can show it',()=>{const input={...data,knowledgeBases:[{id:'root',name:'知识库'},{id:'kb',name:'工具',parentId:'root'}],documents:[{...data.documents[0],knowledgeBaseId:'kb'}]};assert.equal(searchContent(input,'两秒')[0].path,'知识库 / 工具');assert.equal(searchContent(input,'幂等是什么')[0].path,'接口约定');assert.equal(searchContent(input,'整理')[0].path,'');});

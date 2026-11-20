const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {dataImageIds}=require('../../web/domain/image-references.js');
const {detectImageType,MAX_IMAGE_BYTES}=require('./note-images.cjs');
const IMAGE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function backupSummary(data,media=[]){return{libraries:(data.knowledgeBases||[]).length,notes:(data.documents||[]).length+(data.cardDocuments||[]).length,cards:(data.cards||[]).length,reviews:(data.reviewRecords||[]).length,memos:(data.memos||[]).length,candidates:(data.cardCandidates||[]).length,media:media.length,versions:[...(data.documents||[]),...(data.cardDocuments||[])].reduce((n,d)=>n+(d.metadata?.versions||[]).length,0)}}
function validatePortableBackup(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.cards)||!Array.isArray(input.documents)||['__proto__','prototype','constructor'].some(key=>Object.hasOwn(input,key)))throw Error('不是有效的MemoKeep备份');
 if(input.version!=null&&![1,2].includes(input.version))throw Error('备份版本暂不支持');
 for(const key of ['documents','cardDocuments','cards','items','knowledgeBases','cardFolders','cardNotebooks','memos','plans','focusSessions','noteTags','cardCandidates','sourceChanges','reviewRecords','freeReviews','trash']){
  if(input[key]!=null&&!Array.isArray(input[key]))throw Error(`备份字段${key}应为列表`);
  const ids=new Set();for(const row of input[key]||[]){if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id))throw Error(`备份字段${key}含无效或重复ID`);ids.add(row.id)}
 }
 for(const document of [...(input.documents||[]),...(input.cardDocuments||[])])if(document.metadata?.versions!=null&&!Array.isArray(document.metadata.versions))throw Error('备份笔记历史应为列表');
 if(input.settings!=null&&(typeof input.settings!=='object'||Array.isArray(input.settings)))throw Error('备份设置无效');
 const media=input.backup?.media||[],seen=new Set();let bytes=0;
 if(!Array.isArray(media))throw Error('备份媒体清单无效');
 const decoded=media.map(image=>{if(!image||!IMAGE_ID.test(image.id)||seen.has(image.id)||typeof image.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)||image.data.length%4)throw Error('备份图片数据无效');seen.add(image.id);const buffer=Buffer.from(image.data,'base64'),type=detectImageType(buffer);bytes+=buffer.length;if(!buffer.length||buffer.length>MAX_IMAGE_BYTES||bytes>512*1024*1024||!type)throw Error('备份图片格式或大小无效');if(image.sha256&&crypto.createHash('sha256').update(buffer).digest('hex')!==image.sha256)throw Error('备份图片校验失败');return{id:image.id,bytes:buffer,...type}});
 const data=structuredClone(input);delete data.backup;
 const references=new Set(dataImageIds(data));if(input.backup?.mediaIncluded&&[...references].some(id=>!seen.has(id)))throw Error('完整备份缺少引用的图片，请重新导出');
 return{data,media:decoded,summary:backupSummary(data,media),legacy:!input.backup?.mediaIncluded};
}
async function createPortableBackup(data,readImage){
 const media=[];for(const id of new Set(dataImageIds(data))){const image=await readImage(id);if(!image?.dataUrl)throw Error(`图片${id}无法读取，完整备份未导出`);const encoded=image.dataUrl.split(',')[1],bytes=Buffer.from(encoded,'base64');media.push({id,mimeType:image.mimeType,data:encoded,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}
 return{...structuredClone(data),backup:{format:'MemoKeep',version:1,exportedAt:new Date().toISOString(),mediaIncluded:true,media}};
}
async function installBackupMedia(root,media){
 const directory=path.join(root,'images');await fs.mkdir(directory,{recursive:true});const originals=[];
 const rollback=async()=>{for(const entry of [...originals].reverse()){for(const file of await fs.readdir(directory))if(file.startsWith(entry.id+'.'))await fs.rm(path.join(directory,file),{force:true});for(const file of entry.files)await fs.writeFile(path.join(directory,file.name),file.bytes)}};
 try{for(const image of media){if(!image||!IMAGE_ID.test(image.id))throw Error('图片ID无效');const files=[];for(const name of await fs.readdir(directory))if(name.startsWith(image.id+'.'))files.push({name,bytes:await fs.readFile(path.join(directory,name))});originals.push({id:image.id,files});const target=path.join(directory,`${image.id}.${image.extension}`),temporary=target+'.restore-'+crypto.randomUUID();await fs.writeFile(temporary,image.bytes,{flag:'wx'});for(const file of files)await fs.rm(path.join(directory,file.name),{force:true});await fs.rename(temporary,target)}return rollback}catch(error){await rollback();throw error}
}
module.exports={backupSummary,validatePortableBackup,createPortableBackup,installBackupMedia};

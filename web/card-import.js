(function(root) {
  function parseCardCSV(text) {
    const rows = []; let row = [], cell = '', quoted = false, closedQuote = false;
    text = String(text).replace(/^\uFEFF/, '');
    for (let i=0;i<text.length;i++) {
      const c=text[i];
      if(c==='"') {
        if(quoted && text[i+1]==='"') {cell+='"';i++;}
        else if(quoted) {quoted=false;closedQuote=true;}
        else {if(cell || closedQuote) throw new Error('CSV 引号位置无效');quoted=true;}
      }
      else if(c===',' && !quoted) {row.push(cell);cell='';closedQuote=false;}
      else if((c==='\n'||c==='\r')&&!quoted) {row.push(cell);if(row.some(value=>value.trim()))rows.push(row);row=[];cell='';closedQuote=false;if(c==='\r'&&text[i+1]==='\n')i++;}
      else if(closedQuote) {if(!/[ \t]/.test(c)) throw new Error('CSV 闭合引号后存在无效内容');}
      else cell+=c;
    }
    if(quoted) throw new Error('CSV 引号未闭合');
    row.push(cell);if(row.some(value=>value.trim()))rows.push(row);
    const header=rows.shift() || [], find=names=>header.findIndex(value=>names.includes(value.trim().toLowerCase()));
    const q=find(['问题','question']),a=find(['答案','answer']),t=find(['标签','tags']);
    if(q<0||a<0) throw new Error('CSV 需要“问题”和“答案”两列');
    if(!rows.length) throw new Error('CSV 中没有卡片');
    return rows.map((row,index)=>{const question=(row[q]||'').trim(),answer=(row[a]||'').trim();if(!question||!answer)throw new Error(`第 ${index+2} 行问题或答案为空`);return {question,answer,tags:t<0?[]:(row[t]||'').split('|').map(tag=>tag.trim()).filter(Boolean)};});
  }
  if(typeof module!=='undefined'&&module.exports) module.exports={parseCardCSV};
  else root.MemoKeepCardImport={parseCardCSV};
})(globalThis);

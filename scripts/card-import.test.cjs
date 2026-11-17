const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseCardCSV}=require('../web/card-import.js');
test('export-format CSV preserves multiline answers, quotes, commas and tags',()=>{
 assert.deepEqual(parseCardCSV('\uFEFF问题,答案,标签,下次复习时间\r\n"什么,意思？","第一行\n第二行 ""引号""",a|b,2026-01-01'),[{question:'什么,意思？',answer:'第一行\n第二行 "引号"',tags:['a','b']}]);
});
test('invalid imports fail before creating any cards',()=>{
 for(const csv of ['问题,答案','错误,标题\na,b','问题,答案\n只有问题,','问题,答案\n"缺少闭合,答案'])assert.throws(()=>parseCardCSV(csv));
});
test('CSV rejects quotes in unquoted fields and trailing text after a quoted field', () => {
 for (const csv of ['问题,答案\na"b,c','问题,答案\n"a"tail,b']) assert.throws(() => parseCardCSV(csv), /引号/);
});
test('English CSV supports CRLF, empty trailing lines and optional tags', () => {
 assert.deepEqual(parseCardCSV('question,answer\r\n"Q","A"\r\n\r\n'), [{question:'Q',answer:'A',tags:[]}]);
});

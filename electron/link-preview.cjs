const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const domino = require('@mixmark-io/domino');

function publicAddress(ip) {
  const value = ip.toLowerCase();
  if (value.includes(':')) return !/^(::|fc|fd|fe[89ab]|ff)/.test(value) && !value.includes('.');
  const [a,b] = value.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&b===168 || a===100&&b>=64&&b<=127);
}
function safeUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持此链接');
  return url;
}
function readPage(url, redirects=0) {
  return new Promise((resolve,reject)=>{
    const req = (url.protocol==='https:'?https:http).get(url, {
      headers:{'User-Agent':'Mozilla/5.0 (compatible; MemoKeep/1.0; LinkPreview)',Accept:'text/html,application/xhtml+xml'},
      lookup(host,options,callback) {
        dns.lookup(host,{all:true},(error,addresses)=>{
          if(error) return callback(error);
          if(!addresses.length || addresses.some(item=>!publicAddress(item.address))) return callback(new Error('不支持访问此地址'));
          if(options.all) callback(null,addresses); else callback(null,addresses[0].address,addresses[0].family);
        });
      }
    },res=>{
      if(res.statusCode>=300 && res.statusCode<400 && res.headers.location) {
        res.resume(); if(redirects>=5) return reject(new Error('重定向次数过多'));
        try { resolve(fetchPage(safeUrl(res.headers.location,url),redirects+1)); } catch(e){reject(e)} return;
      }
      if(res.statusCode!==200 || !/text\/html|application\/xhtml\+xml/i.test(res.headers['content-type']||'')) {res.resume();reject(new Error('网页暂时无法读取'));return;}
      let size=0; const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){req.destroy(new Error('网页过大'));return;}chunks.push(chunk)});
      res.on('error',reject);
      res.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8'),url:url.href}));
    });
    const timer=setTimeout(()=>req.destroy(new Error('读取网页超时')),10000);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);
  });
}
function fetchPage(url,redirects=0) {
  // Literal IP addresses bypass Node's DNS lookup hook.
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(require('node:net').isIP(host)&&!publicAddress(host)) return Promise.reject(new Error('不支持访问此地址'));
  return readPage(url,redirects);
}
function parseLinkPreview(html,url) {
  const doc=domino.createWindow(html).document;
  const values=new Map();
  for(const meta of Array.from(doc.querySelectorAll('meta'))) {
    const key=(meta.getAttribute('property')||meta.getAttribute('name')||'').toLowerCase();
    if(!values.has(key))values.set(key,meta.getAttribute('content')||'');
  }
  const clean=(s,max)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,max);
  let image='';
  const raw=values.get('og:image')||values.get('twitter:image')||doc.querySelector('link[rel="icon"],link[rel="shortcut icon"]')?.getAttribute('href');
  if(raw)try{image=safeUrl(raw,url).href}catch{}
  return {title:clean(values.get('og:title')||values.get('twitter:title')||doc.title,300),description:clean(values.get('og:description')||values.get('twitter:description')||values.get('description'),600),site:clean(values.get('og:site_name')||new URL(url).hostname,100),image};
}
const cache=new Map();
async function fetchLinkPreview(value) {
  const url=safeUrl(value);
  const cached=cache.get(url.href);if(cached&&Date.now()-cached.time<3600000)return cached.value;
  const page=await fetchPage(url);const result=parseLinkPreview(page.html,page.url);
  if(cache.size>=100)cache.delete(cache.keys().next().value);
  cache.set(url.href,{time:Date.now(),value:result});return result;
}
module.exports={fetchLinkPreview,parseLinkPreview,publicAddress};

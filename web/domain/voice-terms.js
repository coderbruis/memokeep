// 语音作答的术语纠正（design/prototype/voice-terms-20261111.md）：识别前给提示词，识别后按词库把误识别换回术语，
// 改字时学会新的读法，对照时别名也算说中。全部本地计算。
(function expose(root) {
  // 内置词库：「术语|常见误识别（逗号分隔）」。误识别至少 2 个字，避免常用中文词。
  const BUILTIN_SOURCE = `
Kafka|卡夫卡,咖夫卡,卡弗卡,卡夫克
Redis|瑞迪斯,雷迪斯,瑞迪丝,锐迪斯,瑞的斯
MySQL|麦SQL,买SQL,迈SQL,麦sequel,my circle
PostgreSQL|波斯特格雷,post格瑞斯,PG SQL
MongoDB|芒果DB,蒙戈DB,芒果数据库
Elasticsearch|伊拉斯提克,伊莱斯蒂克,ES搜索
RabbitMQ|瑞比MQ,兔子MQ,rabbit MQ
RocketMQ|火箭MQ,rocket MQ,罗克特MQ
ZooKeeper|祖kipper,祖奇珀,zoo keeper
Nginx|恩金克斯,恩基克斯,engine X,引擎X,恩静克斯
Tomcat|汤姆猫,汤姆凯特
Spring Boot|斯普林布特,spring布特,斯普林boot
Spring Cloud|斯普林克劳德,spring克劳德
Spring|斯普林
MyBatis|麦巴提斯,my巴提斯,麦拜提斯
Dubbo|达博,杜博
Netty|奈提,内提
Hadoop|哈杜普,海杜普,哈度普
HBase|H贝斯,H base
Spark|斯帕克
Flink|弗林克,福林克
ClickHouse|click豪斯,克里克豪斯
TiDB|T I DB,提DB,钛DB
SQLite|SQL莱特,sequel light
Docker|多克,刀客,道客,达克
Kubernetes|酷伯内提斯,库伯内提斯,酷伯奈蒂斯,库伯奈提斯
K8s|K八S,K 八 S,开八S
Linux|里纳克斯,林纳克斯,利纽克斯
Git|吉特
GitHub|吉特哈布,git哈布
GitLab|吉特赖普,git来布
Jenkins|詹金斯,真金斯
Maven|麦文,梅文
Gradle|格瑞多,格雷朵
Prometheus|普罗米修斯
Grafana|格拉法纳,格瑞法纳
Nacos|纳科斯,那可斯
Eureka|尤里卡
Consul|康苏尔,康苏
etcd|一题CD,ETCD
Istio|伊斯提欧
Envoy|恩沃伊
Feign|费恩
Ribbon|瑞本
Seata|赛塔
Sentinel|森提纳尔,森缇娜
Swagger|斯瓦格,斯沃格
Postman|波斯特曼
JVM|J V M,杰VM
JDK|J D K,杰DK
JRE|J R E
GC|G C,吉C
OOM|O O M
JIT|J I T
JSON|杰森,杰森格式
YAML|压某,亚莫
XML|X M L
HTTP|H T T P
HTTPS|H T T P S
TCP|T C P
UDP|U D P
IP|I P
DNS|D N S
CDN|C D N
API|A P I
RPC|R P C
gRPC|G RPC,G R P C
SQL|S Q L,sequel
NoSQL|no SQL,诺SQL
ORM|O R M
MVC|M V C
MVCC|M V C C
ACID|A C I D
CAP|C A P
JWT|J W T
OAuth|欧off,o auth,欧奥斯
SSO|S S O
Token|托肯,偷肯,头肯
Cookie|酷奇
Session|赛神,塞申,赛森
HashMap|哈希map,哈希麦普,哈希马普
ConcurrentHashMap|concurrent哈希map,康卡伦特哈希map
ArrayList|阿瑞list,array李斯特
LinkedList|link的list,林克的list
synchronized|森克罗耐斯,森克罗纳斯,辛克罗耐斯
volatile|沃拉泰尔,窝拉太尔,沃勒泰尔
ThreadLocal|thread楼口,斯瑞的local
CAS|C A S
AQS|A Q S
ReentrantLock|瑞恩川特lock,re entrant lock
JavaScript|加瓦斯克瑞普特,JS脚本
TypeScript|太普斯克瑞普特,泰普script
Java|加瓦,扎瓦,渣哇
Python|派森,拍森,排森
Golang|勾浪,够浪,购狼
Rust|若斯特,拉斯特
Kotlin|扣特林,科特林
Swift|斯威夫特
C++|C加加,c plus plus,西加加
Node.js|node JS,诺的JS,node杰斯
React|瑞亚克特,瑞act,锐爱克特
Vue|维U,微U
Angular|安古拉,安格拉
Webpack|web派克,外部pack
Vite|维特
npm|N P M
CSS|C S S
HTML|H T M L
DOM|多姆,D O M
Ajax|阿贾克斯
WebSocket|web扫开特,web socket,微博socket
Electron|伊莱克特隆,伊来克创
Flutter|佛拉特,福拉特
Lua|鲁阿,路啊
Lambda|兰姆达,拉姆达
Serverless|server less,瑟沃勒斯
AWS|A W S
CPU|C P U
GPU|G P U
SSD|S S D
RAID|瑞德
IO|I O
NIO|N I O
BIO|B I O
AIO|A I O
epoll|E poll,一poll,伊破
mmap|M map
Reactor|瑞act or,瑞艾克特
QPS|Q P S
TPS|T P S
SLA|S L A
LRU|L R U
LFU|L F U
FIFO|F I F O
ISR|爱死啊,爱S R,I S R
OSR|O S R
HW|H W
LEO|L E O
leader|黎德,丽德,礼德
follower|佛楼儿,否咯儿,佛罗沃
broker|布洛克,布罗克,不落客
partition|帕忒神,怕题神,帕提神
offset|奥夫塞特,o夫set,偶付赛特
topic|透匹克,偷匹克,头匹克
consumer|康苏默,康速么
producer|普丢瑟,普rodu色
replica|瑞普里卡,瑞普利卡
Raft|瑞夫特,拉夫特
Paxos|帕克索斯,帕克斯奥斯
binlog|拜log,并log,宾log
redo log|瑞度log,瑞do log
undo log|安度log,un do log
InnoDB|因no DB,inno DB,应no DB
MyISAM|麦艾萨姆,my I SAM
B+树|B加树,B plus树
Lucene|露森,卢森
Logstash|log斯达师,罗格stash
Kibana|基巴纳,奇巴纳
Zipkin|兹普金,zip金
SkyWalking|sky沃克,斯盖沃金
Sharding|夏丁,沙丁分片
Canal|卡纳尔
Hystrix|海斯缺克斯,hi斯缺克斯
Gateway|给特委,gate way
`;

  const BUILTIN = BUILTIN_SOURCE.trim().split('\n').map(line => {
    const [term, aliases = ''] = line.split('|');
    return { term: term.trim(), aliases: aliases.split(',').map(alias => alias.trim()).filter(alias => alias.length >= 2), source: 'builtin' };
  });

  const key = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const latin = /[A-Za-z0-9]/;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------- 词库（design/prototype/voice-term-packs-20261111.md） ----------
  // 我的词库（settings.voiceTerms）+ 内置词库（IT 技术 + voice-term-packs.js）+ 自己新建的词库（settings.voicePacks.custom）。
  // settings.voicePacks = { enabled: [id], order: [id], custom: [{ id, name, terms: [{ term, aliases }] }] }。
  const MINE = 'mine', DEFAULT_ENABLED = Object.freeze(['mine', 'it']);
  const builtinPacks = () => {
    const extra = (typeof module !== 'undefined' && module.exports ? require('./voice-term-packs.js') : root.MemoKeepVoiceTermPacks)?.PACKS || [];
    return [{ id: 'it', name: 'IT 技术', terms: BUILTIN }, ...extra];
  };
  let builtinCache = null;
  const BUILTIN_PACKS = () => (builtinCache ||= builtinPacks());
  const cleanTerms = list => (Array.isArray(list) ? list : []).map(item => ({ term: String(item?.term || '').trim(), aliases: [...new Set((item?.aliases || []).map(alias => String(alias).trim()).filter(Boolean))] })).filter(item => item.term);

  // 读设置里的词库配置：没设过时默认「我的词库 + IT 技术」。
  function packConfig(raw) {
    const custom = (Array.isArray(raw?.custom) ? raw.custom : []).filter(pack => pack && typeof pack.id === 'string' && pack.id.startsWith('custom-'))
      .map(pack => ({ id: pack.id, name: String(pack.name || '未命名词库').trim() || '未命名词库', terms: cleanTerms(pack.terms) }));
    const ids = [MINE, ...BUILTIN_PACKS().map(pack => pack.id), ...custom.map(pack => pack.id)];
    const enabled = Array.isArray(raw?.enabled) ? raw.enabled.filter(id => ids.includes(id)) : [...DEFAULT_ENABLED];
    const order = [...new Set([...(Array.isArray(raw?.order) ? raw.order.filter(id => ids.includes(id)) : []), ...ids])];
    return { enabled, order, custom };
  }

  // 所有词库（按用户排的顺序），每个带词条和是否启用。
  function packs({ mine = [], packs: raw } = {}) {
    const config = packConfig(raw);
    const all = new Map([[MINE, { id: MINE, name: '我的词库', kind: 'mine', terms: cleanTerms(mine) }],
      ...BUILTIN_PACKS().map(pack => [pack.id, { id: pack.id, name: pack.name, kind: 'builtin', terms: pack.terms }]),
      ...config.custom.map(pack => [pack.id, { id: pack.id, name: pack.name, kind: 'custom', terms: pack.terms }])]);
    return config.order.map(id => ({ ...all.get(id), enabled: config.enabled.includes(id) }));
  }

  // 纠正用的词条：只取启用的词库，按优先级排好（我的词库最先，然后按词库顺序）；同一个术语只留一条，读法合并。
  function dictionary({ mine = [], disabled = [], packs: raw } = {}) {
    const off = new Set((disabled || []).map(key));
    const list = packs({ mine, packs: raw }).filter(pack => pack.enabled);
    list.sort((a, b) => (a.id === MINE ? -1 : b.id === MINE ? 1 : 0));
    const entries = [], byTerm = new Map();
    for (const pack of list) {
      for (const item of pack.terms) {
        if (pack.kind === 'builtin' && off.has(key(item.term))) continue;
        const own = byTerm.get(key(item.term));
        if (own) { own.aliases = [...new Set([...own.aliases, ...item.aliases])]; continue; }
        const entry = { term: item.term, aliases: [...item.aliases], source: pack.kind === 'builtin' ? 'builtin' : 'mine', pack: pack.id };
        byTerm.set(key(item.term), entry); entries.push(entry);
      }
    }
    return entries;
  }

  // 一段文字里的英文术语（用于提示词）。
  function termsIn(text) {
    const found = [];
    for (const match of String(text || '').normalize('NFKC').matchAll(/[A-Za-z][A-Za-z0-9.+#-]*[A-Za-z0-9+#]|[A-Za-z]{2,}/g)) {
      const word = match[0];
      if (word.length >= 2 && !found.some(item => key(item) === key(word))) found.push(word);
    }
    return found;
  }

  // 提示词（最多 100 个）：这张卡片里的英文术语 → 我的词库 → 各个启用的词库轮流取，避免被一个大词库占满。
  function hints({ question = '', answer = '', entries = dictionary() } = {}, limit = 100) {
    const list = [], seen = new Set();
    const add = word => { const k = key(word); if (!k || seen.has(k) || list.length >= limit) return; seen.add(k); list.push(word); };
    termsIn(`${question}\n${answer}`).forEach(add);
    entries.filter(entry => entry.pack === MINE || !entry.pack && entry.source === 'mine').forEach(entry => add(entry.term));
    const groups = [];
    for (const entry of entries) { let group = groups.find(item => item.pack === entry.pack); if (!group) groups.push(group = { pack: entry.pack, terms: [] }); group.terms.push(entry.term); }
    for (let index = 0; list.length < limit && groups.some(group => index < group.terms.length); index++) groups.forEach(group => { if (index < group.terms.length) add(group.terms[index]); });
    return list;
  }

  // 编译成一个正则：术语和别名都允许字母之间有空格（I S R），英文开头 / 结尾的要求是完整的词。
  const compiled = new WeakMap();
  function matcher(entries) {
    if (compiled.has(entries)) return compiled.get(entries);
    // 同一个读法可能属于多个词库（斯威夫特：Swift / SWIFT）：按优先级都记下，纠正时答案里出现的那个优先。
    const lookup = new Map(), parts = [];
    const add = (form, entry, isTerm) => {
      const k = key(form);
      if (!k) return;
      if (lookup.has(k)) { const list = lookup.get(k); if (!list.some(item => item.entry === entry)) (isTerm ? list.unshift({ entry, isTerm }) : list.push({ entry, isTerm })); return; }
      lookup.set(k, [{ entry, isTerm }]);
      const chars = [...form.replace(/\s+/g, '')];
      const body = chars.map(escape).join('\\s*');
      parts.push({ length: chars.length, source: `${latin.test(chars[0]) ? '(?<![A-Za-z0-9])' : ''}${body}${latin.test(chars[chars.length - 1]) ? '(?![A-Za-z0-9])' : ''}` });
    };
    for (const entry of entries) { add(entry.term, entry, true); for (const alias of entry.aliases) add(alias, entry, false); }
    parts.sort((a, b) => b.length - a.length);
    const result = { lookup, pattern: parts.length ? new RegExp(parts.map(part => part.source).join('|'), 'giu') : null };
    compiled.set(entries, result);
    return result;
  }

  // 答案里出现过的写法优先（kafka / Kafka）。
  function spellingIn(reference, term) {
    const match = String(reference || '').normalize('NFKC').match(new RegExp(`(?<![A-Za-z0-9])${[...term.replace(/\s+/g, '')].map(escape).join('\\s?')}(?![A-Za-z0-9])`, 'i'));
    return match ? match[0] : term;
  }

  // 纠正：返回新文字和纠正过的位置（fixes 只包含「读法 → 术语」，大小写统一不算）。
  function correct(text, { entries = dictionary(), reference = '' } = {}) {
    const source = String(text || '');
    const { lookup, pattern } = matcher(entries);
    if (!pattern || !source) return { text: source, fixes: [] };
    const fixes = [];
    let out = '', last = 0;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const candidates = lookup.get(key(match[0]));
      if (!candidates) continue;
      const found = candidates.length > 1 ? candidates.find(item => spellingIn(reference, item.entry.term) !== item.entry.term || new RegExp(`(?<![A-Za-z0-9])${escape(item.entry.term)}(?![A-Za-z0-9])`, 'i').test(String(reference || ''))) || candidates[0] : candidates[0];
      const to = spellingIn(reference, found.entry.term);
      out += source.slice(last, match.index);
      // 读法 → 术语、拆开念的字母（I S R → ISR）记为纠正；只是大小写不同就直接统一，不标出来。
      if (match[0] !== to && (!found.isTerm || /\s/.test(match[0]) && !/\s/.test(to))) fixes.push({ from: match[0], to, start: out.length, end: out.length + to.length });
      out += match[0] === to ? match[0] : to;
      last = match.index + match[0].length;
    }
    out += source.slice(last);
    return { text: out, fixes };
  }

  // 改字前后对比，找出「原词 → 新词」（新词像术语：英文 / 数字）。
  function learn(before, after, { entries = dictionary(), reference = '' } = {}) {
    const a = [...String(before || '')], b = [...String(after || '')];
    if (a.length * b.length > 400000) return [];
    const rows = a.length + 1, cols = b.length + 1, table = new Uint16Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    // 逐字比较得到改动段（记下在前后文字里的位置）。
    const hunks = [];
    let i = 0, j = 0, start = null;
    const flush = () => { if (start && (start.i < i || start.j < j)) hunks.push({ i0: start.i, i1: i, j0: start.j, j1: j }); start = null; };
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; continue; }
      start ||= { i, j };
      if (j < b.length && (i >= a.length || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) j++; else i++;
    }
    flush();
    // 改动挨着相同的英文字母时（破啦DB → PolarDB），把整个英文词算进来。
    const word = /[A-Za-z0-9.+#]/;
    for (const hunk of hunks) {
      if (hunk.j1 === hunk.j0 || !/[A-Za-z]/.test(b.slice(hunk.j0, hunk.j1).join(''))) continue;
      while (hunk.i0 > 0 && hunk.j0 > 0 && a[hunk.i0 - 1] === b[hunk.j0 - 1] && word.test(b[hunk.j0 - 1])) { hunk.i0--; hunk.j0--; }
      while (hunk.i1 < a.length && hunk.j1 < b.length && a[hunk.i1] === b[hunk.j1] && word.test(b[hunk.j1])) { hunk.i1++; hunk.j1++; }
    }
    const pairs = [];
    for (const hunk of hunks) {
      const from = a.slice(hunk.i0, hunk.i1).join('').trim(), to = b.slice(hunk.j0, hunk.j1).join('').trim();
      if (!from || !to || [...from].length < 2 || !/^[A-Za-z][A-Za-z0-9.+# -]*$/.test(to) || key(from) === key(to)) continue;
      const known = entries.find(entry => key(entry.term) === key(to));
      const term = known ? spellingIn(reference, known.term) : spellingIn(reference, to);
      if (!pairs.some(pair => pair.from === from)) pairs.push({ from, to: term });
    }
    return pairs;
  }

  // 记住：合并进「我的词库」（同一个术语追加读法）。返回新的列表。
  function remember(mine, pairs) {
    const list = (mine || []).map(item => ({ term: item.term, aliases: [...(item.aliases || [])] }));
    for (const { from, to } of pairs || []) {
      const existing = list.find(item => key(item.term) === key(to));
      if (existing) { if (!existing.aliases.some(alias => key(alias) === key(from))) existing.aliases.push(from); }
      else list.push({ term: to, aliases: [from] });
    }
    return list;
  }

  // 加到某个词库：我的词库返回新的 voiceTerms；自己的词库返回新的 voicePacks。
  function addTo(settings, packId, term, aliases) {
    const pair = (aliases.length ? aliases : ['']).map(from => ({ from, to: term }));
    if (packId === MINE) return { voiceTerms: remember(settings.voiceTerms, pair).map(item => ({ ...item, aliases: item.aliases.filter(Boolean) })) };
    const config = packConfig(settings.voicePacks);
    config.custom = config.custom.map(pack => pack.id === packId ? { ...pack, terms: remember(pack.terms, pair).map(item => ({ ...item, aliases: item.aliases.filter(Boolean) })) } : pack);
    return { voicePacks: config };
  }

  const api = { BUILTIN, MINE, DEFAULT_ENABLED, builtinPacks: BUILTIN_PACKS, packConfig, packs, dictionary, termsIn, hints, correct, learn, remember, addTo, normalizeKey: key };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepVoiceTerms = api;
})(globalThis);

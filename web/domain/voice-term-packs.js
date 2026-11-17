// 内置语音词库（design/prototype/voice-term-packs-20261111.md）：除「IT 技术」外的场景词库。
// 「IT 技术」在 web/domain/voice-terms.js（BUILTIN）。格式同那边：「术语|常见误识别（逗号分隔）」，误识别至少 2 个字。
// 字母拆开念（K P I）不用写，纠正时会自动合并。
(function expose(root) {
  const SOURCES = {
    workplace: { name: '职场英语', source: `
deadline|戴德兰,带的赖,得得兰,戴德莱恩
KPI|开批爱,开皮爱
OKR|欧开阿,欧凯阿
meeting|米听,咪婷,迷听
offer|奥佛,欧佛,奥弗
HR|阿吃阿,爱吃阿
CEO|西一欧,西伊欧
CTO|西提欧
CFO|西爱夫欧
PPT|皮皮踢,屁屁踢
feedback|飞的拜克,feed拜克,菲德拜克
follow up|佛楼阿普,follow阿普,佛罗阿普
sync|森克,辛克
align|阿莱恩,额来恩,阿赖恩
schedule|斯盖久,斯凯九,斯给就
review|瑞纽,瑞view
project|普罗杰克特,普洛杰克特
manager|麦尼杰,曼尼杰
brainstorm|布瑞恩斯淘姆,brain斯托姆
workshop|沃克肖普,沃克夏普
agenda|阿真达,阿简达
benchmark|本驰马克,奔驰马克
solution|搜鲁深,索留深
proposal|普珀泽,普罗泡造
onboarding|安伯丁,on包丁
priority|普莱奥瑞提,普莱奥瑞踢
timeline|泰姆莱恩,太姆莱恩
milestone|麦尔斯通,迈尔斯通
demo|德莫,迪莫
MVP|M V P,艾姆维匹
UI|优爱,油爱
UX|优艾克斯
SOP|艾斯欧匹
JD|杰迪,街迪
WFH|W F H
one on one|万安万,1on1
buffer|巴佛,巴弗
case by case|凯斯拜凯斯
OT|欧踢
BD|必迪
KOL|开欧艾欧
`.trim() },
    business: { name: '商务英语', source: `
invoice|因沃斯,音沃伊斯,因袜斯
quotation|夸特神,扣忒神,括忒神
contract|康琼特,看拽克特,康缺克特
ROI|阿欧爱,R O I
budget|巴吉特,巴菊特
margin|马金,玛金
deal|迪奥,低欧
B2B|B兔B,B two B,B 2 B
B2C|B兔C,B two C,B 2 C
FOB|F O B
CIF|C I F
MOQ|M O Q
PO|匹欧
logistics|洛吉斯提克斯,罗吉斯提克斯
shipment|希普门特,西普门特
supplier|色普莱尔,瑟普莱尔
client|克莱恩特,克赖恩特
customer|卡斯特默,卡斯特么
negotiation|尼勾谢神,内勾谢神
revenue|瑞文纽,瑞维纽
profit|普罗菲特,普若菲特
GMV|G M V
SKU|斯库,S K U
CRM|C R M
ERP|E R P
SaaS|萨斯平台
partner|帕特纳,帕特呐
stakeholder|斯dake霍德,斯泰克霍德
pitch|匹驰,皮驰
discount|迪斯康特
refund|瑞方德,瑞放德
sample|散泡,赛泡
order|奥德,欧德
cash flow|凯什flow,卡什弗楼
`.trim() },
    english: { name: '英语（日常）', source: `
OK|欧克,偶尅
email|伊妹儿,伊媚儿,一妹儿
Wi-Fi|歪坊,外fai,歪fai
sorry|骚瑞,搜瑞
happy|嗨皮
VIP|V I P
ID|I D
PDF|P D F
USB|U S B
GPS|G P S
AI|诶爱,A I
ChatGPT|恰特GPT,chat G P T
Zoom|祖姆
vlog|微楼格,V log
DIY|D I Y
cosplay|扣丝play
online|昂莱恩
offline|奥夫莱恩
`.trim() },
    daily: { name: '日常', source: `
iPhone|爱疯,艾锋,爱风
iPad|爱派德,爱拍
App|阿普,爱普
MacBook|麦克布克,麦克book
AirPods|爱泡兹,air泡子
Apple Watch|爱泡沃奇
Windows|温斗斯,温豆丝
Office|奥菲斯
Excel|一克赛尔,艾克塞尔
Google|古狗
YouTube|优图布
KTV|K T V
PS|P S
Logo|楼狗
Bug|巴格
`.trim() },
    finance: { name: '银行金融', source: `
LPR|L P R
ETF|一题F,一提F
IPO|爱批欧,I P O
SWIFT|斯威夫特
APR|A P R
KYC|K Y C
AML|A M L
NPL|N P L
ROE|R O E
EPS|E P S
PE|P E
PB|P B
CDS|C D S
MBS|M B S
FX|F X
LIBOR|莱博,来伯
SOFR|索弗
Visa|维萨
Mastercard|马斯特卡,master卡
POS|破斯,P O S
ATM|A T M
IBAN|爱班,I BAN
QDII|Q D I I
QFII|Q F I I
REITs|瑞兹,R E I T S
FOF|F O F
NAV|N A V
CPI|C P I
PPI|P P I
GDP|G D P
PMI|P M I
M2|M二,M two
fintech|芬泰克
`.trim() }
  };

  const parse = source => source.split('\n').map(line => {
    const [term, aliases = ''] = line.split('|');
    return { term: term.trim(), aliases: aliases.split(',').map(alias => alias.trim()).filter(alias => [...alias].length >= 2) };
  }).filter(item => item.term);

  const PACKS = Object.entries(SOURCES).map(([id, { name, source }]) => ({ id, name, terms: parse(source) }));
  if (typeof module !== 'undefined' && module.exports) module.exports = { PACKS };
  else root.MemoKeepVoiceTermPacks = { PACKS };
})(globalThis);

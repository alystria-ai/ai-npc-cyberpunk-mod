// Chinese money words for bridge/eddies-languages.mjs: Simplified and Traditional characters in one grammar, Mandarin phrasing.
// Chinese is not split into words, so every verb pattern carries its object (a money noun, a sum or a particle), and the engine's
// clause split (。！？；、，) does the rest. Every character that differs between the two scripts is written both ways.
export default {
  language: 'zh',
  // Money nouns and slang (never the verbs lend, borrow, pay or owe themselves). 錢 is in both scripts; 块/塊 is not here alone (a classifier: "一块石头").
  // A spelled-out sum with its unit ("两百块", "一万欧") and a bare scale at a clause end or before a particle ("借我一千") count as money too, so the
  // line gate (screenWords reads a line only with a digit or one of these) lets them through; the unit lookahead keeps "一块石头" out.
  money: String.raw`钱|錢|欧元|歐元|欧洲美元|歐洲美元|美元|爱迪|愛迪|艾迪|埃迪|eddies?|eurodollars?|现金|現金|钞票|鈔票|资金|資金|贷款|貸款|借款|欠款|工资|工資|薪水|小费|小費|零钱|零錢|闲钱|閒錢|存款|积蓄|積蓄|债务|債務|赏金|賞金|[零〇一二两兩三四五六七八九十百千万萬壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]+(?:块|塊|欧|歐|元)(?!石|头|頭|子|地|肉|饼|餅|蛋糕|面包|麵包|布|木|铁|鐵|玻璃|表|砖|磚|糖|冰|纸|紙|东西|東西)|(?:十|拾|百|佰|千|仟|万|萬)(?=$|[，,。！？!?.；;、吧吗嗎啊呢給给好拜求谢謝])`,
  // Verb phrases only money fits, even with no noun or sum.
  moneyPhrases: String.raw`帮我垫|幫我墊|给我垫|給我墊|垫付|墊付|还钱|還錢|欠我钱|欠我錢`,
  // What may follow a sum as its currency. 块/塊 counts unless a thing follows it; 欧/歐 unless it is 欧洲; 元 unless it is 元旦 or 元素.
  unit: String.raw`欧元|歐元|欧(?![洲盟美式亚陆拉])|歐(?![洲盟美式亞陸拉])|美元|爱迪|愛迪|艾迪|埃迪|eddies|eddie|块(?!石|头|子|地|肉|饼|蛋糕|面包|布|木|铁|玻璃|表|砖|糖|冰|纸|东西)|塊(?!石|頭|子|地|肉|餅|蛋糕|麵包|布|木|鐵|玻璃|表|磚|糖|冰|紙|東西)|元(?![旦素首帅帥])`,
  // Words that may follow a bare sum: particles and polite endings ("500吧", "两百给我").
  after: String.raw`吧|吗|嗎|好吗|好嗎|行吗|行嗎|好不好|行不行|给我|給我|给你|給你|给|給|呢|啊|呀|拜托|拜託|求你|求求你|谢谢|謝謝|please|lol`,
  // Words that make a number after a money verb something else: time, counts, people, ages, years, pieces.
  notMoney: String.raw`分钟|分鐘|分(?![钱錢])|秒|小时|小時|钟头|鐘頭|天|次|个|個|人|岁|歲|发|發|年|月|周|週|星期|礼拜|禮拜|点|點|遍|回|只|条|條|句|首|杯|瓶|份|种|種|层|層|位|章|公里|米|步|件|本|台|把|会儿|會兒`,
  // Clause breaks besides the punctuation.
  but: String.raw`但是|可是|不过|不過|然后|然後|不然`,
  // "until tomorrow" / "到发薪" / "等到明天": cut out before the time test, so "借我五百到明天" is still an ask.
  until: String.raw`(?:到|等到|直到)(?:明天|明日|后天|後天|发薪|發薪|发工资|發工資|月底|下周|下週|下礼拜|下禮拜|下个月|下個月)`,
  // Joking words: a clause after one (or the clause itself) is no ask ("开玩笑啦，你别真把钱借给我").
  joke: String.raw`开个玩笑|開個玩笑|开玩笑|開玩笑|玩笑|逗你|闹着玩|鬧著玩|说着玩|說著玩|只是说说|只是說說|假装|假裝|别真|別真|别当真|別當真`,
  numbers: {
    words: {零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 兩: 2, 贰: 2, 貳: 2, 三: 3, 叁: 3, 參: 3, 四: 4, 肆: 4, 五: 5, 伍: 5,
      六: 6, 陆: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9},
    scales: {十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000},
    tail: true,
  },
  intents: [
    // V asks the character to pay back what the character owes V: "你还我钱", "你还欠我一千块", "你欠我两百", "什么时候还我三百", "我的钱呢".
    ['reclaim', String.raw`你(?:什么|什麼|啥|何|几|幾)(?:时|時)(?:候)?|(?:什么|什麼|啥|何|几|幾)(?:时|時)(?:候)?(?:还|還)(?!你)|你(?:还|還)?欠我|你(?:该|該|快|赶紧|趕緊|赶快|趕快|得|要)?(?:还|還)(?:我|钱|錢)|欠我(?:的)?(?:钱|錢)|(?:钱|錢|钞票|鈔票)(?:还|還)(?:给|給)?我|(?:还|還)(?:给|給)我|(?:还|還)我|我的(?:钱|錢)呢|(?<!我)快(?:还|還)`],
    // V pays back what V owes: "我还你五百", "我把钱还给你", "这是我欠你的", "欠你的五百块", "还你", "扯平了".
    ['repay', String.raw`我(?:把)?(?:钱|錢)?(?:还|還)(?:钱|錢)?(?:给|給)?你|把(?:钱|錢)(?:还|還)(?:给|給)?你|(?:还|還)(?:给|給)你|还你|還你|欠你|这是(?:我)?欠你的|這是(?:我)?欠你的|扯平|两清|兩清|两不相欠|兩不相欠`],
    // V asks whether the character needs money: "你需要钱吗", "你想借钱吗", "要不要借点钱".
    ['lend', String.raw`(?:你|您)(?:需要|缺|要|想要|想)(?:借)?(?:点|點|些|一些)?(?:钱|錢|现金|現金)|要不要(?:借)?(?:点|點|些|一些)?(?:钱|錢)`],
    // V asks the character to lend or give V money: "借我五百", "给我两百块", "我想跟你借三千", "我需要两千", "帮我垫".
    // "借钱给你" and "借给你的钱" are not asks: the lookahead keeps them out.
    ['borrow', String.raw`借我|借給我|借给我|跟你借|向你借|借(?:个|個|点|點|些|一点|一點|一笔|一筆)(?!.*(?:给你|給你))|(?:我)?(?:想|要|能|可以)借(?!你)|(?<!你)借(?:一点|一點|点|點|些|一笔|一筆)?(?:钱|錢)(?!给你|給你)|帮我付|幫我付|帮我出|幫我出|帮我垫|幫我墊|给我垫|給我墊|给我|給我|我(?:需要|缺|差|还差|還差)`],
    // V offers to lend the character money: "我借你三百", "我借給你一千塊", "借你钱花", "我能帮你垫三百", "我先墊你三千". "借给你的钱" is a debt already made.
    ['lend', String.raw`借(?:一点|一點|点|點|些)?(?:钱|錢)?(?:给你|給你)(?!的)|借你(?!的)|(?:帮|幫)你(?:垫|墊)|(?:先)?(?:垫|墊)你`],
    // V gives the character money: a gift, a tip, a payment, the change, a token of thanks.
    ['give', String.raw`(?<!借)给你|(?<!借)給你|付你|付給你|付给你|转你|轉你|转给你|轉給你|打给你|打給你|汇给你|匯給你|拿着|拿著|拿去|收下|收着|收著|不用找|留着|留著|打赏|打賞|赏你|賞你|小费|小費|心意|谢礼|謝禮|辛苦费|辛苦費|这是你的|這是你的|(?<!借)给你的|(?<!借)給你的|这是给你的|這是給你的`],
  ],
  // Not a refusal of a request that still asks ("你能不能借我50", "你不借我吗", "能不能借我"): these forms are excluded.
  negation: String.raw`(?<!能)不能借(?!我)|不(?:会|會)(?:借|给|給|还|還)|(?<!你)不(?:借|给|給|还|還|付|转|轉)|没借|沒借|没给|沒給|没还|沒還|绝不|絕不|从不|從不|永不|从来不|從來不|决不|決不|才不|不可能|没门|沒門|想都别想|想都別想|一分都|一毛都|别想|別想|别借|別借|别给|別給|拒绝|拒絕|不想(?:借|给|給|还|還)|不用还|不用還|不必还|不必還|不要(?:你的)?(?:钱|錢)`,
  // A condition about V's own act ("如果我借你", "要是你借我钱") refuses. A polite offer ("如果你需要，我可以借你") is not one. A joke too.
  hypothetical: String.raw`(?:如果|要是|假如|若是|假使|假设|假設)(?!你需要|需要的话|需要就|有需要|你缺)|万一|萬一|要不是|就算|即使|哪怕|想象|想像|只是说说|只是說說|随便说说|隨便說說|开个玩笑|開個玩笑|开玩笑|開玩笑|玩笑|逗你|闹着玩|鬧著玩|说着玩|說著玩|假装|假裝|别真|別真|别当真|別當真`,
  // Future and past: "明天", "以后", "昨天", "已经", "刚才", "借过", "前天". "之前借的" and "上次借的" describe a loan already made: not a time (the lookahead).
  // "到明天" / "等到发薪" is no postponement (until): the lookbehind keeps it out.
  later: String.raw`(?<!到|等到|直到)(?:明天|明日|后天|後天|以后|以後|之后|之後|过几天|過幾天|过两天|過兩天|下次|改天|回头|回頭|晚点|晚點|稍后|稍後|等会|等會|等下|等一下|等我|发了工资|發了工資|发工资|發工資|发薪|發薪|下周|下週|下星期|下礼拜|下禮拜|下个月|下個月|昨天|昨晚|昨夜|前天|已经|已經|刚才|剛才|刚刚|剛剛|还了|還了|借过|借過|早就)|(?:之前|以前|上次)(?!借|欠)`,
};

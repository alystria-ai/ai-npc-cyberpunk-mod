// Korean money words for bridge/eddies-languages.mjs (verb-final, particles after nouns; words are space-separated but read as characters, so a pattern is a
// plain substring match with optional spaces `\s?` where people put one or leave it out).
export default {
  language: 'ko',
  // Money nouns: 에디, 돈, 빚, 현금, 용돈, and 원 only after a number (so 원래 "originally" is not money).
  money: String.raw`에디|에디스|유로달러|유로|달러|돈|빚|현금|용돈|잔돈|(?<=[0-9일이삼사오육칠팔구십백천만억])\s?원`,
  // Money-only phrases: settle up, send, tip, fare, meal money, gift money, keep-the-change money, sincerity-gift, accommodation (융통).
  moneyPhrases: String.raw`청산|정산|상환|변제|송금|환급|환불|대출|팁|사례금|축하금|수고비|차비|택시비|밥값|술값|커피값|이자|거스름돈|잔돈|성의|융통`,
  // What may follow a sum as its currency.
  unit: String.raw`에디|에디스|유로달러|유로|달러|원`,
  // Words that may follow a bare sum ("500 좀 빌려줘", "5000 정도").
  after: String.raw`정도|쯤|만큼|만|좀|도|씩|까지|뿐|라도|은|는|을|를`,
  // Counters after a number: "3분", "2번", "5일", "2명" are not sums.
  notMoney: String.raw`분|시간|초|일|번|명|개|발|살|회|번째|주|개월|달|년|시|권|마리|대|킬로|미터|페이지|잔|병|층|판`,
  // "until tomorrow" / "until payday": cut out before the time test, so an ask with a deadline stays an ask.
  until: String.raw`내일까지|월급날까지|다음 주까지|다음주까지|다음 달까지|다음달까지|이번 주까지|이번주까지|이번 달까지`,
  numbers: {
    // Sino-Korean digits: a bare digit word ("이", "사", "오") is no sum; a run must carry a scale (십 백 천 만).
    words: {'일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '칠': 7, '팔': 8, '구': 9},
    scales: {'십': 10, '백': 100, '천': 1000, '만': 10000},
    unitOnly: false,
  },
  intents: [
    // V asks the character to pay back what the character owes: 갚아 줘, 돌려줘, 내놔, 언제 갚을 거야, 돌려줄 수 있어?, 내 돈 돌려줘.
    ['reclaim', String.raw`갚아(?!\s?(?:줄|드릴|두|놓|보|준))|돌려\s?(?:줘|줘라|주세요|주라|주실래요|주실래|줄래)|돌려\s?줄 수 (?:있|있어|있니|있냐|있어요)|내놔|내놓(?:아|으세요|으라)|언제\s?(?:갚|돌려|줄)[^。、]{0,6}?(?:거야|거냐|거니|래|냐|니|는데|건데)|내\s?(?:돈|에디)[^。、]{0,10}?(?:줘|줄래|주세요|달라|돌려)`],
    // V pays back what V owes: 갚을게, 돌려줄게, 갚아드릴게, 돌려드릴게, 청산할게, 셈 끝났다 (settled), 빌린 돈 갚을게, 빌린 거 얼마였지 (a debt in the line).
    ['repay', String.raw`갚(?:을|는다|겠|을게|을께|을 거|을거|을게요|을 테니|을 수)|갚아\s?(?:줄게|줄께|줄 거|드릴)|갚아줄게|돌려\s?(?:줄게|줄께|줄 거|줄거|줄 테니|드릴)|청산(?:할게|할께|하)|정산(?:할게|하)|상환(?:할게|하)|변제(?:할게|하)|셈 (?:끝|정리)|(?:빌린|빌려간|빌렸던)\s?(?:돈|거|것|에디)(?![^。、]*[0-9일이삼사오육칠팔구십백천만])`],
    // V asks whether the character needs money: 돈 필요해?, 돈 필요하냐?, 돈 얼마나 필요해?; or offers a loan with a subject or a condition ("내가 삼만 에디 빌려줄 수
    // 있는데", "쪼들리면 빌려줄 수 있어"). Read before 'borrow', whose "빌려줄 수 있어" is an ask.
    ['lend', String.raw`돈 (?:좀 |얼마나 |많이 |조금 )?필요(?:하니|하냐|하세요|하나요|하신가요|한가|한가요|한 거 있)|돈 (?:좀 |얼마나 |많이 |조금 )?필요(?:해|해요)\s*$|(?:쪼들리|궁하|필요하)(?:면|시면)[^。、]{0,15}?빌려\s?줄 수|내가 ?[^。、]{0,15}?빌려\s?줄 (?:수|게|께|테니|까)`],
    // V asks the character to lend or give V money: 빌려줘, 빌려줄래, 빌려주세요, 빌릴게, 꿔줘, 주세요, 줘, 주면 안 돼?, 융통해 줘, 사줘.
    // A statement that V is short ("돈 없어", "빌려야 해") is no ask.
    ['borrow', String.raw`빌려\s?(?:줘|줄래|주세요|주실래요|주실래|주라|줘라|주실 수|줄 수 있|주면 안 돼|주면 안 될까|주면 안돼|줄 수 있니|줄 수 있냐|줄 수 있어요)|빌릴\s?(?:게|수)|빌려\s?도\s?(?:돼|될까|되나|되니|돼요)|빌리고 싶|빌려\s?쓸게|꿔\s?(?:줘|줄래|주세요|주라|주실래요|줄 수 있)|융통해\s?(?:줘|줄래|주세요|주실래요|주라)|융통해줄래|(?<!받아\s?|돌려\s?|갚아\s?)줘(?!도|면|서|지|는|냐|니|야 할|야지)|(?<!받아\s?|돌려\s?|갚아\s?)줄래|(?<!받아\s?|돌려\s?|갚아\s?)주세요|(?<!받아\s?|돌려\s?|갚아\s?)주실래요|사줘`],
    // V offers to lend the character money: 빌려줄게, 빌려줄까, 빌려줄 테니, 꿔줄게, 빌려주고 싶으면, 빌려줄 수도, 융통해 줄 수 있어.
    ['lend', String.raw`빌려\s?줄게|빌려\s?줄께|빌려\s?줄 테니|빌려\s?줄까|빌려\s?줄 수도|빌려주고 싶|꿔\s?줄게|꿔\s?줄께|꿔\s?줄까|꿔\s?줄 테니|융통해\s?줄 수|융통해\s?줄게|융통해\s?줄께|융통해\s?줄 테니|융통해\s?줄까`],
    // V gives the character money: a gift, a tip, a payment, a fare, keep the change, a presentative next to a sum (자, 이거 300 에디 / 여기 칠백 에디), 받아 at the
    // end of a clause with a sum ("팁이야, 오백 에디 받아"). 줄게 and 드릴게 count only after a money word or a sum ("택시비 줄게"), not after a verb stem ("알려줄게").
    ['give', String.raw`(?<=[\s0-9원디돈]|^)(?:줄게|줄께|줄 거야|줄 거|줄거|줄 테니|줄테니|드릴게|드릴께|드릴 거|드릴게요|드릴께요|줄까|드릴까|쏠게|쏠께|쏠 거|쏠 테니|쏠까)|보낼게|보낼께|보내줄게|보내 줄게|보내줄께|받아\s?(?:줘|주세요|라|둬|두세요|요)|(?<!얼마 |얼마나 |언제 |뭐 |어디 |누가 |어떻게 )받아\s*$|받아둬|받으세요|가져가|가져 가|가져가라|넣어 둬|넣어둬|거스름돈은? ?(?:됐어|됐다|필요 없어|괜찮아)|잔돈은? ?(?:됐어|됐다|필요 없어|괜찮아)|내 성의|성의(?:야|예요|다|이야|니까)|^\s*(?:자|여기|이거|이건)\s+(?=[^。、]*(?:[0-9]|[일이삼사오육칠팔구십백천만](?:\s?[일이삼사오육칠팔구십백천만])*\s?(?:에디|원)))`],
  ],
  // A refusal in any form: 안 빌려줘, 못 줘, 싫어, 절대 안, 못 갚, 빌려주지 않을게, 융통 못 (but 안 빌려줄래? and 빌려주면 안 돼? are asks).
  negation: String.raw`다시는|안 (?:빌려줄게|빌려줄께|빌려줄 거|빌려줄거|빌려준다|빌려줘|빌려주겠|빌려주지|빌려 줄게|빌려 줄께|빌려 줄 거|줄게|줄께|줄 거|줄거|준다|드릴게|드릴께|갚을게|갚을 거|갚을거|갚을게요|갚을 거야|보낼게|보낼께|받아줄|줄 테니)|못 (?:빌려|줘|줄|갚|받|드려|보내|돌려|융통)|융통 (?:못|안)|(?:빌려|줘|줄|갚|드리|돌려|보내)(?:주지|지) (?:않|안|못)(?:을게|을 거|을거|겠|겠어|겠다|는다|아|어|지|을게요)|싫어|싫다|싫은데|싫어요|절대 (?:안|못)|안 갚|못 갚|빌려줄 생각 없|줄 생각 없`,
  // Not a real offer: 만약 500 빌려주면, 농담으로, 빌려준다면.
  hypothetical: String.raw`만약|만일|가정|가령|상상|농담|장난|(?:빌려|줬|준|드린|갚)다면|(?:빌려|줬|준)더라면`,
  // Future, past and conditions, as a refusal of the ask (also in the clause before the ask): 내일, 나중에, 이따, 돈 생기면, 월급 받으면, 갚았, 빌려줬잖아,
  // 줬어, and a condition on a giving or repaying verb (빌려주면, 갚아주면, 준다면) unless it is "빌려주면 안 돼?".
  later: String.raw`내일(?!까지)|나중에|이따|다음에|다음 주(?!까지)|다음주(?!까지)|다음 달|다음달|언젠가|조만간|어제|그저께|이미|벌써|갚았|빌려줬|줬어|줬잖아|줬는데|드렸잖아|드렸어|보냈어|돈 생기면|돈 들어오면|월급 받으면|월급날|월급 나오면|돈 벌면|벌면|(?:빌려|줄|드리|갚|돌려|꿔)(?:아|어)?(?:주)?(?:면|다면)(?!\s?안\s?(?:돼|될))`,
  // "Joking" words: a clause after one is no ask ("농담이야, 500 에디 빌려줘").
  joke: String.raw`농담|장난|농담이야|장난이야`,
};

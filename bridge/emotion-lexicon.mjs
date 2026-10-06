// Emotion lexicon for the local-voice expression planner (bridge/emotion-analysis.mjs).
// Written for this project (NRC-style categories: each word has one family and an
// intensity 0..1), not copied from any third-party list. Words are base forms;
// the analyser also tries simple inflections. No network, no model.
export const FAMILIES = Object.freeze(['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation']);

const parse = text => Object.fromEntries(text.trim().split(/\s+/).map(entry => {
  const at = entry.lastIndexOf(':');
  return [entry.slice(0, at).replace(/_/g, ' '), Number(entry.slice(at + 1))];
}));

export const WORDS = Object.freeze({
  joy: parse(`
    glad:.55 happy:.7 happiness:.7 joy:.8 joyful:.8 delighted:.8 thrilled:.85 excited:.7 exciting:.6 awesome:.75 amazing:.7
    great:.5 good:.3 nice:.35 fine:.15 wonderful:.8 fantastic:.8 brilliant:.7 perfect:.65 beautiful:.55 lovely:.6 sweet:.4
    cool:.4 fun:.55 funny:.6 hilarious:.8 laugh:.6 laughing:.6 giggle:.6 grin:.55 grinning:.55 smile:.55 smiling:.55 smirk:.4
    cheers:.6 celebrate:.7 celebration:.7 party:.45 win:.5 won:.5 winning:.5 victory:.7 triumph:.7 success:.55 nailed:.7
    proud:.6 pride:.5 lucky:.55 fortunate:.5 blessed:.6 enjoy:.5 enjoyed:.5 enjoying:.5 pleasure:.55 pleased:.55 relieved:.45
    relief:.45 yay:.75 woohoo:.8 hooray:.8 hurray:.8 preem:.7 nova:.7 choice:.4 finally:.35 bliss:.8
    delight:.7 cheerful:.6 cheery:.55 merry:.55 upbeat:.5 optimistic:.45 hope:.35 hopeful:.45 charming:.5 adorable:.55 cute:.5
    fabulous:.75 superb:.7 terrific:.7 magnificent:.7 gorgeous:.6 stunning:.55 epic:.6 legendary:.6 kickass:.65 badass:.5
    hell_yeah:.8 fuck_yeah:.85 damn_good:.65 best:.55 favorite:.45 favourite:.45 treasure:.4 gift:.35 reward:.4 bonus:.4
    haha:.8 hahaha:.85 heh:.55 hehe:.7 lol:.65 lmao:.7 rofl:.7 ha:.35 chuckle:.55 chuckled:.55 giggled:.6 laughed:.65
    thrill:.65 rush:.4 stoked:.7 pumped:.65 psyched:.65 elated:.8 ecstatic:.9 overjoyed:.9 content:.4 satisfied:.45 satisfying:.5
    comfortable:.3 cozy:.4 peaceful:.35 calm:.2 relaxed:.35 chill:.3 enjoyable:.5 playful:.5 witty:.4 clever:.4 smart:.25
    welcome:.35 congratulations:.7 congrats:.7 bravo:.6 kudos:.5 impressive:.5 impressed:.5 yes:.25 yeah:.15 sure:.1`),
  trust: parse(`
    trust:.65 trusted:.6 trusting:.6 believe:.35 faith:.5 loyal:.65 loyalty:.65 honest:.5 honesty:.5 reliable:.5 safe:.45
    safety:.4 protect:.5 protected:.45 protecting:.5 guard:.3 support:.45 supporting:.45 backup:.5 cover:.3 promise:.6
    promised:.55 swear:.35 vow:.5 friend:.5 friends:.5 friendship:.55 family:.55 together:.4 team:.4 partner:.45 partners:.45
    ally:.5 allies:.5 brother:.5 sister:.5 buddy:.45 pal:.4 companion:.45 care:.5 caring:.55 cares:.5 cared:.5 kind:.45
    kindness:.5 gentle:.4 tender:.5 warm:.45 warmth:.5 comfort:.45 thanks:.4 thank:.45 grateful:.55 gratitude:.55
    appreciate:.5 appreciated:.5 respect:.45 admire:.5 admired:.5 depend:.45 rely:.45 count_on:.6 got_your_back:.8
    have_your_back:.8 here_for_you:.75 always_here:.7 stay:.3 stick_with:.55 stand_with:.55 with_you:.35 love:.55 loved:.55
    loving:.55 adore:.6 dear:.4 darling:.5 sweetheart:.55 babe:.4 honey:.4 choom:.35 chica:.35 hermano:.4 amigo:.4 compadre:.4
    mija:.45 mijo:.45 cariño:.5 forgive:.4 forgiven:.4 understand:.3 understood:.3 listen:.15 sorry_for:.2 mean_it:.35`),
  sadness: parse(`
    sad:.65 sadness:.7 sadly:.55 unhappy:.6 depressed:.75 depressing:.7 miserable:.75 grief:.8 grieve:.8 grieving:.8 mourn:.8
    mourning:.8 cry:.65 crying:.7 cried:.65 tears:.65 weep:.7 sob:.7 sobbing:.7 hurt:.5 hurts:.55 hurting:.55 pain:.5
    painful:.55 ache:.5 aching:.55 heartbroken:.85 heartbreak:.8 broken:.45 lonely:.7 loneliness:.7 alone:.5 abandoned:.65
    empty:.5 hollow:.5 numb:.5 lost:.5 loss:.6 lose:.35 losing:.4 gone:.4 miss:.5 missed:.45 missing:.4 regret:.6 regrets:.6
    regretted:.6 sorry:.35 apologize:.35 apology:.3 died:.7 dead:.5 death:.55 dying:.6 die:.4 funeral:.7 grave:.5 buried:.5
    bury:.45 tragic:.7 tragedy:.7 sorrow:.8 sorrowful:.8 mournful:.75 melancholy:.7 gloomy:.55 bleak:.55 hopeless:.7
    despair:.8 desperate:.5 helpless:.55 powerless:.5 tired:.35 exhausted:.45 weary:.5 drained:.45 defeated:.55 failure:.5
    failed:.45 fail:.35 flatlined:.6 flatline:.5 never_came_back:.8 too_late:.6 wish_things:.55 shouldve:.35 should_have:.35
    if_only:.55 farewell:.5 goodbye:.4 gone_now:.65 rip:.5 passed_away:.7 killed:.45 murdered:.5 sacrifice:.45 sacrificed:.5
    haunt:.5 haunted:.55 nightmare:.4 suffer:.55 suffering:.65 suffered:.55 weak:.25 pity:.4 shame:.4 ashamed:.5 guilt:.5 guilty:.5
    lament:.6 whimper:.5 sigh:.35 sighed:.35 disappointed:.5 disappointing:.5 disappointment:.5 let_down:.5 betrayed_me:.4`),
  anger: parse(`
    angry:.65 anger:.7 furious:.9 fury:.85 rage:.9 enraged:.9 mad:.55 pissed:.7 piss_off:.7 pissed_off:.75 annoyed:.4
    annoying:.45 annoy:.4 irritated:.45 irritating:.5 frustrated:.45 frustrating:.5 hate:.7 hated:.65 hating:.65 hatred:.8
    despise:.75 loathe:.75 resent:.55 resentment:.55 bitter:.45 outraged:.8 outrageous:.65 insult:.5 insulted:.55 offend:.4
    offended:.5 disrespect:.55 disrespected:.6 betray:.7 betrayed:.75 betrayal:.75 traitor:.7 liar:.6 lie:.35 lied:.5
    lying:.45 cheat:.5 cheated:.55 steal:.35 stole:.4 scum:.6 bastard:.65 bastards:.7 asshole:.65 assholes:.7 jerk:.4
    idiot:.5 idiots:.55 moron:.5 morons:.55 stupid:.45 dumbass:.55 gonk:.5 gonks:.5 choomba_better:.5 fool:.4 pathetic:.5
    kill:.45 killing:.4 destroy:.45 destroyed:.4 smash:.4 crush:.4 payback:.7 revenge:.75 vengeance:.75 pay_for:.5 will_pay:.65
    burn:.35 punish:.5 fight:.3 attack:.25 war:.3 violent:.4 violence:.4 shut_up:.65 get_out:.35 back_off:.55 how_dare:.8
    enough:.35 sick_of:.65 fed_up:.65 tired_of:.55 piss_me_off:.8 corpo_scum:.7 damn_it:.6 goddamn:.55 goddamned:.55
    bullshit:.5 crap:.25 screw_you:.8 screw_this:.6 screw:.35 fuck_you:.9 son_of_a_bitch:.8 hostile:.4 aggressive:.35
    threat:.35 threaten:.4 threatened:.4 warn:.2 warning:.2 grudge:.5 spite:.5 contempt:.55 disgrace:.5 unacceptable:.5`),
  fear: parse(`
    scared:.65 scare:.5 scary:.55 afraid:.65 fear:.65 fearful:.65 terrified:.9 terrify:.8 terror:.85 horror:.7 horrified:.85
    frightened:.7 frightening:.7 nervous:.5 anxious:.55 anxiety:.55 worry:.45 worried:.55 worrying:.5 panic:.8 panicked:.8
    dread:.7 dreading:.7 uneasy:.5 unease:.5 tense:.4 tension:.4 edgy:.4 jumpy:.45 paranoid:.55 paranoia:.55 suspicious:.35
    danger:.5 dangerous:.55 risk:.35 risky:.4 deadly:.5 lethal:.5 threatening:.4 trap:.55 trapped:.65 ambush:.6 ambushed:.65
    cornered:.65 hunted:.6 chase:.35 chased:.4 run:.3 running:.3 flee:.5 hide:.4 hiding:.4 careful:.3 watch_out:.6
    look_out:.65 get_down:.6 take_cover:.6 incoming:.55 behind_you:.6 bad_feeling:.7 dont_like_this:.7 dont_like_the_look:.7
    creepy:.55 eerie:.5 spooky:.5 haunting:.4 shaking:.45 trembling:.55 shiver:.45 cold_sweat:.65 what_if:.4 oh_god:.6
    oh_no:.55 oh_shit:.65 holy_shit:.4 shit:.25 uh_oh:.5 yikes:.45 brace:.4 pray:.4 hope_to_god:.5 hope_so:.2 doomed:.7`),
  disgust: parse(`
    gross:.65 disgusting:.8 disgust:.7 disgusted:.75 nasty:.6 vile:.8 revolting:.85 repulsive:.85 repugnant:.8 filthy:.6
    filth:.6 foul:.6 rotten:.55 rotting:.6 rot:.45 stink:.5 stinks:.5 stinking:.55 reek:.55 reeks:.55 smell:.15 sickening:.7
    sick:.35 nauseating:.75 nauseous:.55 puke:.6 vomit:.65 barf:.55 ugh:.55 yuck:.65 eww:.65 ew:.55 bleh:.45 blegh:.5
    tasteless:.35 trashy:.45 sleazy:.55 slimy:.55 creep:.4 pervert:.55 perverted:.55 sleaze:.5 scumbag:.6 degenerate:.5
    sordid:.5 depraved:.65 corrupt:.45 contaminated:.5 toxic:.4 infected:.45 maggots:.6 slime:.5 grease:.25 sewer:.4
    garbage:.35 trash:.35 waste:.25 pathetic_excuse:.5 pitiful:.35 beneath_me:.4 cringe:.5 eugh:.55`),
  surprise: parse(`
    wow:.6 whoa:.65 woah:.65 whoah:.65 oh:.12 ooh:.35 huh:.35 what:.18 really:.2 seriously:.25 unbelievable:.6
    incredible:.55 astonishing:.7 astonished:.7 astounded:.75 amazed:.6 stunned:.6 shocked:.7 shocking:.65 shock:.55
    surprised:.65 surprise:.6 surprising:.55 unexpected:.5 suddenly:.4 sudden:.35 out_of_nowhere:.55 no_way:.7 cant_believe:.7
    you_did_what:.7 wait_what:.7 hold_on:.35 holy:.3 holy_shit:.55 jesus:.3 damn:.3 whoa_there:.65 gasp:.55 gasped:.55
    speechless:.6 jaw_drop:.7 mindblowing:.65 mind_blown:.7 bizarre:.35 strange:.3 weird:.3 odd:.2 impossible:.45
    didnt_expect:.55 never_thought:.4 of_all_people:.5 who_would_have:.4 plot_twist:.5 twist:.3 whaaat:.7 omg:.6 oh_my_god:.6`),
  anticipation: parse(`
    curious:.55 curiosity:.55 wonder:.35 wondering:.4 wondered:.35 interesting:.5 interested:.45 intrigued:.55 intrigue:.45
    fascinating:.55 fascinated:.55 hmm:.4 hm:.3 huh_interesting:.4 tell_me:.4 explain:.3 show_me:.4 think:.2 thinking:.25
    consider:.25 maybe:.15 perhaps:.15 idea:.4 plan:.35 plans:.35 scheme:.4 listen:.3 look:.15 see:.1 watch:.2 notice:.25
    expect:.3 expecting:.35 waiting:.25 wait:.2 soon:.2 tonight:.2 tomorrow:.2 ready:.3 prepare:.3 prepared:.3 ahead:.15
    mission:.3 job:.15 gig:.3 target:.25 chance:.3 opportunity:.4 adventure:.5 explore:.4 discover:.4 find_out:.45
    what_do_you_think:.5 got_an_idea:.55 you_know_what:.35 guess_what:.5 check_this:.4 check_it_out:.45 look_at_this:.45
    imagine:.4 suppose:.2 question:.3 mystery:.4 secret:.4 rumor:.35 rumour:.35 clue:.4 lead:.3`),
});

// Multi-word phrases are stored with spaces above; the analyser scans 2-4 word windows.
export const INTENSIFIERS = Object.freeze(Object.fromEntries(Object.entries({
  very: 1.35, really: 1.3, so: 1.25, super: 1.4, totally: 1.3, absolutely: 1.5, completely: 1.4, utterly: 1.5, extremely: 1.5,
  incredibly: 1.5, insanely: 1.5, ridiculously: 1.4, fucking: 1.55, damn: 1.35, bloody: 1.35, freaking: 1.3, goddamn: 1.4,
  truly: 1.3, deeply: 1.4, seriously: 1.25, awfully: 1.3, terribly: 1.35, hella: 1.4, way: 1.25, such: 1.2, most: 1.25,
  proper: 1.2, genuinely: 1.3, pure: 1.2,
}).map(([k, v]) => [k, v])));
export const DIMINISHERS = Object.freeze({
  slightly: .6, somewhat: .65, kinda: .65, kind_of: .65, sort_of: .65, sorta: .65, little: .65, bit: .6, a_bit: .6,
  a_little: .6, almost: .7, barely: .5, hardly: .45, fairly: .8, pretty: .85, mildly: .55, vaguely: .5, maybe: .75,
  just: .9, only: .8, rather: .9,
});
export const NEGATORS = Object.freeze(new Set(['not', 'no', 'never', "don't", 'dont', "doesn't", "didn't", "isn't", "wasn't",
  "aren't", "weren't", "won't", "wouldn't", "can't", 'cant', "couldn't", "shouldn't", 'hardly', 'barely', 'cannot', 'without',
  'neither', 'nor', 'nobody', 'nothing', 'none', 'nowhere', 'ain\'t', 'aint']));
export const CONTRAST = Object.freeze(new Set(['but', 'however', 'though', 'although', 'yet', 'except', 'still', 'anyway',
  'nevertheless', 'nonetheless', 'whereas']));
export const PROFANITY = Object.freeze(new Set(['fuck', 'fucking', 'fucked', 'fucker', 'shit', 'shitty', 'bullshit', 'damn',
  'damned', 'goddamn', 'goddamned', 'hell', 'bitch', 'bastard', 'asshole', 'ass', 'crap', 'piss', 'pissed', 'dick', 'bloody',
  'motherfucker', 'gonk', 'dammit']));
export const ADDRESS = Object.freeze(new Set(['choom', 'chooms', 'chica', 'hermano', 'amigo', 'amiga', 'mija', 'mijo', 'kid',
  'buddy', 'pal', 'friend', 'love', 'babe', 'darling', 'sweetheart', 'honey', 'cariño', 'compadre', 'brother', 'sis',
  'mamá', 'mama', 'papi', 'boss', 'champ']));
// Whole-phrase sarcasm patterns that are reliable in dialogue; matched on the lowercase sentence.
export const SARCASM = Object.freeze([
  /\boh,? (great|wonderful|perfect|fantastic|brilliant|nice|lovely|sure)\b/, /\byeah,? right\b/,
  /\bthanks a lot\b/, /\breal (smart|clever|nice|mature|helpful)\b/, /\bgood job,? (genius|hero|einstein)\b/,
  /\bwhat a (genius|surprise|shock|brilliant)\b/, /\bhow (nice|original|clever|helpful)\b/, /\bsure,? because\b/,
  /\bas if\b/, /\bbig surprise\b/, /\bno kidding\b/, /\bwell,? (that went|that was) (great|well|smooth)\b/,
  /\bgee,? thanks\b/, /\bi'm (so )?(sure|impressed)\b/, /\bfascinating\.{0,3}$/, /\bwow,? (really|thanks)\b/,
]);
